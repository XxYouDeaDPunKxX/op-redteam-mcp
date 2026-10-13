import OAuthProvider from "@cloudflare/workers-oauth-provider";
export { GptAccount } from "./providers/gpt-account";

import { createDcrPolicy } from "./auth/dcr";
import { createAuthorizationHandler } from "./auth/github";
import { isLocalRequest, resolveRuntimeOrigin, type RuntimeOrigin } from "./auth/origin";
import type { Env } from "./env";
import { enforceIngress } from "./http/ingress";
import { dcrRateKey } from "./security/identity";
import { mcpApiHandler } from "./server";

function response(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

function createProvider(env: Env, origin: RuntimeOrigin): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: origin.mcpEndpoint,
    apiHandler: mcpApiHandler,
    defaultHandler: createAuthorizationHandler(origin),
    authorizeEndpoint: origin.authorizeEndpoint,
    tokenEndpoint: origin.tokenEndpoint,
    clientRegistrationEndpoint: origin.registerEndpoint,
    scopesSupported: ["review:invoke"],
    resourceMetadata: {
      resource: origin.mcpResource,
      authorization_servers: [origin.publicOrigin],
      scopes_supported: ["review:invoke"],
      bearer_methods_supported: ["header"],
    },
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: false,
    disallowPublicClientRegistration: false,
    accessTokenTTL: 3_600,
    refreshTokenTTL: 2_592_000,
    clientRegistrationTTL: 7_776_000,
    clientRegistrationCallback: createDcrPolicy(env.ALLOWED_DCR_REDIRECT_URIS),
    onError: () => undefined,
  });
}

function canonicalIp(raw: string | null): string | undefined {
  if (!raw || raw.length > 64 || raw !== raw.trim()) return undefined;
  const ipv4 = raw.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return ipv4.map((part) => String(Number(part))).join(".");
  }
  if (!raw.includes(":") || !/^[0-9a-fA-F:.]+$/.test(raw)) return undefined;
  try {
    const hostname = new URL(`http://[${raw}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function applyDcrRateLimit(request: Request, env: Env): Promise<Response | undefined> {
  const ip = canonicalIp(request.headers.get("CF-Connecting-IP"));
  if (!ip) return response(400);
  try {
    const key = await dcrRateKey(env.IDENTITY_HMAC_KEY, ip);
    const outcome = await env.RATE_LIMITER.limit({ key });
    return outcome.success ? undefined : response(429);
  } catch {
    return response(500);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const authMode = env.AUTH_MODE ?? "github";
    if (authMode !== "github" && authMode !== "none") return response(500);

    let origin: RuntimeOrigin;
    try {
      origin = resolveRuntimeOrigin(env.PUBLIC_ORIGIN, authMode === "none", env.MCP_RESOURCE);
    } catch {
      return response(500);
    }

    const requestOrigin = new URL(request.url).origin;
    if (requestOrigin !== origin.publicOrigin) return response(421);

    const ingress = await enforceIngress(request);
    if (ingress.kind === "response") return ingress.response;
    const boundedRequest = ingress.request;

    if (authMode === "none") {
      if (!isLocalRequest(boundedRequest) || new URL(boundedRequest.url).pathname !== "/mcp") return response(404);
      return mcpApiHandler.fetch(boundedRequest, env, ctx);
    }

    if (new URL(boundedRequest.url).pathname === "/register" && boundedRequest.method === "POST") {
      const limited = await applyDcrRateLimit(boundedRequest, env);
      if (limited) return limited;
    }
    return createProvider(env, origin).fetch(boundedRequest, env, ctx);
  },
  scheduled(_event, env, ctx) {
    if ((env.AUTH_MODE ?? "github") !== "github") return;
    const origin = resolveRuntimeOrigin(env.PUBLIC_ORIGIN, false, env.MCP_RESOURCE);
    ctx.waitUntil(
      createProvider(env, origin).purgeExpiredData(env, { batchSize: 50 }).then((result) => {
        env.ANALYTICS.writeDataPoint({
          blobs: ["oauth_cleanup", env.VERSION_METADATA?.id ?? "unknown"],
          doubles: [
            result.grantsChecked,
            result.grantsPurged,
            result.tokensChecked,
            result.tokensPurged,
            result.done ? 1 : 0,
          ],
        });
      }),
    );
  },
};

export default worker;

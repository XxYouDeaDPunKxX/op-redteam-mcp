import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";

import { base64UrlEncode } from "../src/security/encoding";

interface TestEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

function executionContext(): ExecutionContext {
  return {
    props: {},
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, options?: string | { type?: string }) {
      const value = values.get(key) ?? null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      if (typeof value !== "string") throw new TypeError("test KV accepts string values only");
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      return {
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
  } as unknown as KVNamespace;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

describe("workers-oauth-provider opaque-token compatibility", () => {
  it("exchanges an authorization code when the stable GitHub subject contains no colon", async () => {
    const defaultHandler: ExportedHandler<TestEnv> = {
      async fetch(request, env) {
        if (!env.OAUTH_PROVIDER) return new Response("missing provider", { status: 500 });
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authRequest,
           userId: "github-999999999999999",
          metadata: {},
          scope: ["review:invoke"],
           props: { github_user_id: 999999999999999, login: "allowed" },
          revokeExistingGrants: true,
          revokeExistingGrantsBatchSize: 50,
        });
        return Response.redirect(redirectTo, 302);
      },
    };
    const provider = new OAuthProvider<TestEnv>({
      apiRoute: "/mcp",
      apiHandler: { fetch: () => new Response("ok") },
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["review:invoke"],
      resourceMetadata: {
        resource: "https://server.example",
        authorization_servers: ["https://server.example"],
        scopes_supported: ["review:invoke"],
        bearer_methods_supported: ["header"],
      },
      allowImplicitFlow: false,
      allowPlainPKCE: false,
      allowTokenExchangeGrant: false,
      clientIdMetadataDocumentEnabled: false,
      disallowPublicClientRegistration: false,
    });
    const env: TestEnv = { OAUTH_KV: memoryKv() };
    const ctx = executionContext();
    const redirectUri = "https://client.example/oauth/callback";

    const registration = await provider.fetch(
      new Request("https://server.example/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          client_name: "Compatibility test",
        }),
      }),
      env,
      ctx,
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const authorizeUrl = new URL("https://server.example/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "review:invoke",
      state: "downstream-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: "https://server.example",
    }).toString();

    const authorization = await provider.fetch(new Request(authorizeUrl), env, ctx);
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("Location")!);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(code!.split(":")).toHaveLength(3);

    const token = await provider.fetch(
      new Request("https://server.example/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: code!,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: "https://server.example",
        }),
      }),
      env,
      ctx,
    );
    expect(token.status).toBe(200);
    await expect(token.json()).resolves.toMatchObject({ token_type: "bearer", scope: "review:invoke" });
  });
});

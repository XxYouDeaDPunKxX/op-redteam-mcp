import type { ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { Env } from "../env";
import { base64UrlEncode, randomBase64Url, timingSafeEqual, utf8 } from "../security/encoding";
import {
  AUTHORIZE_COOKIE,
  CALLBACK_COOKIE,
  clearCookie,
  openCookie,
  readCookie,
  sealCookie,
} from "./cookies";
import type { RuntimeOrigin } from "./origin";
import {
  authorizeEnvelopeSchema,
  callbackEnvelopeSchema,
  fromAuthRequest,
  toAuthRequest,
  validateFresh,
  type AuthorizeEnvelope,
  type CallbackEnvelope,
  type DownstreamAuthorizationRequest,
} from "./transaction";

function noStore(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function withClearedCookie(response: Response, name: string, path: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearCookie(name, path));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderConsent(clientName: string, resource: string, csrfState: string, setCookie: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize OP RedTeam</title></head><body><main><h1>Authorize OP RedTeam</h1>
<p><strong>${escapeHtml(clientName)}</strong> requests permission to invoke the OP Adversarial Pressure MCP tools.</p>
<dl><dt>Scope</dt><dd>review:invoke</dd><dt>Resource</dt><dd>${escapeHtml(resource)}</dd></dl>
<form method="post" action="/authorize"><input type="hidden" name="csrf_state" value="${escapeHtml(csrfState)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": setCookie,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function validateClient(provider: OAuthHelpers, request: DownstreamAuthorizationRequest): Promise<ClientInfo> {
  const client = await provider.lookupClient(request.clientId);
  if (!client || !client.redirectUris.includes(request.redirectUri)) throw new TypeError("invalid_client");
  return client;
}

function downstreamDenied(request: DownstreamAuthorizationRequest): Response {
  try {
    const target = new URL(request.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "authorization denied");
    target.searchParams.set("state", request.downstream_state);
    return redirect(target.toString());
  } catch {
    return noStore(403, "Authorization denied");
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function parseAllowedIds(csv: string): Set<number> {
  const parts = csv.split(",").map((value) => value.trim()).filter(Boolean);
  if (parts.length === 0) throw new TypeError("empty_allowlist");
  const ids = new Set<number>();
  for (const part of parts) {
    if (!/^[1-9]\d{0,15}$/.test(part)) throw new TypeError("invalid_allowlist");
    const id = Number(part);
    if (!Number.isSafeInteger(id)) throw new TypeError("invalid_allowlist");
    ids.add(id);
  }
  return ids;
}

async function exchangeGitHubCode(
  code: string,
  verifier: string,
  env: Env,
  origin: RuntimeOrigin,
): Promise<{ accessToken: string; emptyScope: boolean } | undefined> {
  try {
    const body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: origin.callbackEndpoint,
      code_verifier: verifier,
    });
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "op-redteam-mcp/1.0",
      },
      body,
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.access_token !== "string" || record.access_token.length < 16 || record.access_token.length > 512) return undefined;
    if (typeof record.scope !== "string") return { accessToken: record.access_token, emptyScope: false };
    const scopes = record.scope.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
    return { accessToken: record.access_token, emptyScope: scopes.length === 0 };
  } catch {
    return undefined;
  }
}

async function fetchGitHubIdentity(accessToken: string): Promise<{ id: number; login: string } | undefined> {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "op-redteam-mcp/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { id, login } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof login !== "string" || !/^[A-Za-z0-9-]{1,256}$/.test(login)) {
      return undefined;
    }
    return { id: id as number, login: login.toLowerCase() };
  } catch {
    return undefined;
  }
}

async function revokeGitHubToken(accessToken: string, env: Env): Promise<boolean> {
  try {
    const basic = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
    const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "User-Agent": "op-redteam-mcp/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

async function readAuthorizeEnvelope(request: Request, env: Env, origin: RuntimeOrigin): Promise<AuthorizeEnvelope> {
  const encoded = readCookie(request, AUTHORIZE_COOKIE);
  if (!encoded) throw new TypeError("missing_cookie");
  const opened = await openCookie(AUTHORIZE_COOKIE, "/authorize", encoded, env.COOKIE_ENCRYPTION_KEY, origin.publicOrigin);
  return validateFresh(authorizeEnvelopeSchema.parse(opened), Math.floor(Date.now() / 1000));
}

async function readCallbackEnvelope(request: Request, env: Env, origin: RuntimeOrigin): Promise<CallbackEnvelope> {
  const encoded = readCookie(request, CALLBACK_COOKIE);
  if (!encoded) throw new TypeError("missing_cookie");
  const opened = await openCookie(CALLBACK_COOKIE, "/callback", encoded, env.COOKIE_ENCRYPTION_KEY, origin.publicOrigin);
  return validateFresh(callbackEnvelopeSchema.parse(opened), Math.floor(Date.now() / 1000));
}

async function getAuthorize(request: Request, env: Env, origin: RuntimeOrigin): Promise<Response> {
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const downstream = fromAuthRequest(parsed, origin.mcpResource);
    const client = await validateClient(env.OAUTH_PROVIDER, downstream);
    const now = Math.floor(Date.now() / 1000);
    const envelope: AuthorizeEnvelope = {
      downstream_authorization_request: downstream,
      csrf_state: randomBase64Url(32),
      issuedAt: now,
      expiresAt: now + 600,
    };
    const cookie = await sealCookie(
      AUTHORIZE_COOKIE,
      "/authorize",
      envelope,
      env.COOKIE_ENCRYPTION_KEY,
      origin.publicOrigin,
    );
    return renderConsent(client.clientName ?? "MCP client", origin.mcpResource, envelope.csrf_state, cookie);
  } catch {
    return noStore(400, "Invalid authorization request");
  }
}

async function postAuthorize(request: Request, env: Env, origin: RuntimeOrigin): Promise<Response> {
  let envelope: AuthorizeEnvelope;
  try {
    envelope = await readAuthorizeEnvelope(request, env, origin);
    const form = await request.formData();
    const csrfState = form.get("csrf_state");
    const decision = form.get("decision");
    if (typeof csrfState !== "string" || !timingSafeEqual(csrfState, envelope.csrf_state)) throw new TypeError("csrf_mismatch");
    await validateClient(env.OAUTH_PROVIDER, envelope.downstream_authorization_request);
    if (decision === "deny") {
      return withClearedCookie(downstreamDenied(envelope.downstream_authorization_request), AUTHORIZE_COOKIE, "/authorize");
    }
    if (decision !== "approve") throw new TypeError("invalid_decision");

    const upstreamGithubState = randomBase64Url(32);
    const githubPkceVerifier = randomBase64Url(64);
    const now = Math.floor(Date.now() / 1000);
    const callbackEnvelope: CallbackEnvelope = {
      downstream_authorization_request: envelope.downstream_authorization_request,
      upstream_github_state: upstreamGithubState,
      github_pkce_verifier: githubPkceVerifier,
      issuedAt: now,
      expiresAt: now + 600,
    };
    const callbackCookie = await sealCookie(
      CALLBACK_COOKIE,
      "/callback",
      callbackEnvelope,
      env.COOKIE_ENCRYPTION_KEY,
      origin.publicOrigin,
    );
    const target = new URL("https://github.com/login/oauth/authorize");
    target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    target.searchParams.set("redirect_uri", origin.callbackEndpoint);
    target.searchParams.set("scope", "");
    target.searchParams.set("state", upstreamGithubState);
    target.searchParams.set("code_challenge", await pkceChallenge(githubPkceVerifier));
    target.searchParams.set("code_challenge_method", "S256");
    return redirect(target.toString(), [clearCookie(AUTHORIZE_COOKIE, "/authorize"), callbackCookie]);
  } catch {
    return withClearedCookie(noStore(403, "Authorization request rejected"), AUTHORIZE_COOKIE, "/authorize");
  }
}

async function getCallback(request: Request, env: Env, origin: RuntimeOrigin): Promise<Response> {
  let envelope: CallbackEnvelope;
  try {
    envelope = await readCallbackEnvelope(request, env, origin);
    await validateClient(env.OAUTH_PROVIDER, envelope.downstream_authorization_request);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (!state || !timingSafeEqual(state, envelope.upstream_github_state)) throw new TypeError("state_mismatch");
    if (url.searchParams.has("error")) {
      return withClearedCookie(downstreamDenied(envelope.downstream_authorization_request), CALLBACK_COOKIE, "/callback");
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 512) throw new TypeError("invalid_code");
    const allowedIds = parseAllowedIds(env.ALLOWED_GITHUB_USER_IDS);
    const token = await exchangeGitHubCode(code, envelope.github_pkce_verifier, env, origin);
    if (!token) {
      return withClearedCookie(downstreamDenied(envelope.downstream_authorization_request), CALLBACK_COOKIE, "/callback");
    }

    let identity: { id: number; login: string } | undefined;
    let internalFailure = false;
    if (token.emptyScope) {
      identity = await fetchGitHubIdentity(token.accessToken);
      internalFailure = !identity;
    }
    const allowed = token.emptyScope && identity !== undefined && allowedIds.has(identity.id);
    const revoked = await revokeGitHubToken(token.accessToken, env);
    if (!revoked || internalFailure) {
      return withClearedCookie(noStore(502, "Identity verification unavailable"), CALLBACK_COOKIE, "/callback");
    }
    if (!allowed || !identity) {
      return withClearedCookie(downstreamDenied(envelope.downstream_authorization_request), CALLBACK_COOKIE, "/callback");
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: toAuthRequest(envelope.downstream_authorization_request),
      // workers-oauth-provider uses ':' as the delimiter in its opaque
      // authorization codes and access tokens. Keep the stable GitHub
      // subject namespaced without introducing another delimiter.
      userId: `github-${identity.id}`,
      metadata: {},
      scope: ["review:invoke"],
      props: { github_user_id: identity.id, login: identity.login },
      revokeExistingGrants: true,
      revokeExistingGrantsBatchSize: 50,
    });
    return withClearedCookie(redirect(redirectTo), CALLBACK_COOKIE, "/callback");
  } catch {
    return withClearedCookie(noStore(403, "Authorization callback rejected"), CALLBACK_COOKIE, "/callback");
  }
}

export function createAuthorizationHandler(origin: RuntimeOrigin): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/authorize" && request.method === "GET") return getAuthorize(request, env, origin);
      if (url.pathname === "/authorize" && request.method === "POST") return postAuthorize(request, env, origin);
      if (url.pathname === "/callback" && request.method === "GET") return getCallback(request, env, origin);
      return noStore(404, "Not found");
    },
  };
}

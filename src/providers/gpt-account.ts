import { createOpenAIOAuthRequest, exchangeOpenAIOAuthCode, parseJwtClaims, refreshOpenAIOAuthTokens, type OpenAIOAuthRequest, type OpenAIOAuthSession } from "@openai-oauth/core";
import type { Env } from "../env";
import { base64UrlDecode, base64UrlEncode, timingSafeEqual, utf8 } from "../security/encoding";

const ACCOUNT_KEY = "credentials:v1";
const LOGIN_KEY = "pending-login:v1";
const CALLBACK = "http://localhost:1455/auth/callback";
const DOMAIN = utf8("op-chatgpt-account-v1");
interface Credentials extends OpenAIOAuthSession { deviceId: string }
interface Pending extends OpenAIOAuthRequest { createdAt: number }
interface Cipher { iv: string; data: string }

function expiry(token: string): number {
  const exp = parseJwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isSafeInteger(exp) ? exp : 0;
}
function plan(session: OpenAIOAuthSession): string | undefined {
  for (const token of [session.accessToken, session.idToken]) {
    const auth = parseJwtClaims(token)?.["https://api.openai.com/auth"];
    if (auth && typeof auth === "object" && "chatgpt_plan_type" in auth && typeof auth.chatgpt_plan_type === "string") return auth.chatgpt_plan_type;
  }
  return undefined;
}
function valid(session: Credentials): boolean {
  return typeof session.accessToken === "string" && session.accessToken.length <= 16_000 && expiry(session.accessToken) > 0 &&
    typeof session.refreshToken === "string" && session.refreshToken.length > 0 && session.refreshToken.length <= 16_000 &&
    typeof session.accountId === "string" && session.accountId.length > 0 && session.accountId.length <= 128 &&
    typeof session.deviceId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(session.deviceId) &&
    typeof plan(session) === "string" && /^[a-z0-9_-]{1,40}$/i.test(plan(session)!);
}

/** Credential-only owner. Its routes are accessible through the Worker binding, not public HTTP. */
export class GptAccount {
  private tail: Promise<void> = Promise.resolve();
  private pendingToken?: Promise<Response>;
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private response(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  }
  private error(status: number, code: string): Response { return this.response({ code }, status); }
  private exclusive(operation: () => Promise<Response>): Promise<Response> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async key(): Promise<CryptoKey> {
    const bytes = base64UrlDecode(this.env.COOKIE_ENCRYPTION_KEY);
    if (bytes.length < 32) throw new Error("key_unavailable");
    const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: DOMAIN }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  private async save(name: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(`${name}:op-chatgpt-account-v1`) }, await this.key(), utf8(JSON.stringify(value)));
    await this.state.storage.put(name, { iv: base64UrlEncode(iv), data: base64UrlEncode(new Uint8Array(data)) });
  }
  private async load<T>(name: string): Promise<T | undefined> {
    const cipher = await this.state.storage.get<Cipher>(name);
    if (!cipher) return undefined;
    if (typeof cipher.iv !== "string" || typeof cipher.data !== "string" || cipher.data.length > 90_000) throw new Error("invalid_cipher");
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(cipher.iv), additionalData: utf8(`${name}:op-chatgpt-account-v1`) }, await this.key(), base64UrlDecode(cipher.data));
    return JSON.parse(new TextDecoder().decode(clear)) as T;
  }
  private async body(request: Request): Promise<Record<string, unknown> | undefined> {
    const text = await request.text();
    if (text.length > 4096) return undefined;
    try {
      const value: unknown = JSON.parse(text || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }
  private tokenFetch(onStatus: (status: number) => void): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://auth.openai.com/oauth/token" || request.method !== "POST") throw new Error("unexpected_destination");
      // workerd accepts manual/follow; manual also prevents forwarding credentials on redirects.
      const response = await fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      onStatus(response.status);
      return response;
    };
  }
  private async startLogin(request: Request): Promise<Response> {
    const body = await this.body(request);
    if (!body || body.redirectUri !== CALLBACK) return this.error(400, "invalid_redirect");
    const flow = await createOpenAIOAuthRequest({ redirectUri: CALLBACK });
    await this.save(LOGIN_KEY, { ...flow, createdAt: Date.now() });
    return this.response({ authorizationUrl: flow.authorizationUrl, state: flow.state, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  }
  private async completeLogin(request: Request): Promise<Response> {
    const body = await this.body(request);
    if (!body || typeof body.code !== "string" || !body.code || body.code.length > 2048 || typeof body.state !== "string" || body.state.length > 256) return this.error(400, "invalid_callback");
    const flow = await this.load<Pending>(LOGIN_KEY);
    if (!flow || Date.now() - flow.createdAt > 600_000 || !timingSafeEqual(body.state, flow.state)) return this.error(401, "invalid_login_state");
    await this.state.storage.delete(LOGIN_KEY);
    let status: number | undefined;
    try {
      const tokens = await exchangeOpenAIOAuthCode({ code: body.code, codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri, fetch: this.tokenFetch(value => { status = value; }) });
      if (!tokens.accountId || !tokens.refreshToken) return this.error(401, "session_invalid");
      const existing = await this.load<Credentials>(ACCOUNT_KEY);
      const session: Credentials = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken: tokens.idToken, accountId: tokens.accountId, deviceId: existing?.deviceId ?? crypto.randomUUID() };
      if (!valid(session)) return this.error(401, "session_invalid");
      await this.save(ACCOUNT_KEY, session);
      return this.response({ initialized: true, plan: plan(session), expiresAt: expiry(session.accessToken) });
    } catch { return this.error(status === 401 || status === 403 ? status : 503, "login_exchange_unavailable"); }
  }
  private async status(): Promise<Response> {
    const session = await this.load<Credentials>(ACCOUNT_KEY);
    if (!session) return this.response({ initialized: false });
    if (!valid(session)) return this.error(401, "session_invalid");
    return this.response({ initialized: true, plan: plan(session), expiresAt: expiry(session.accessToken), needsRenewal: expiry(session.accessToken) <= Math.floor(Date.now() / 1000) + 60 });
  }
  private async token(force = false): Promise<Response> {
    const previous = await this.load<Credentials>(ACCOUNT_KEY);
    if (!previous) return this.error(503, "session_missing");
    if (!valid(previous)) return this.error(401, "session_invalid");
    let next = previous;
    let refreshed = false;
    if (force || expiry(previous.accessToken) <= Math.floor(Date.now() / 1000) + 60) {
      let status: number | undefined;
      try {
        const tokens = await refreshOpenAIOAuthTokens({ refreshToken: previous.refreshToken!, fetch: this.tokenFetch(value => { status = value; }) });
        if (tokens.accountId && tokens.accountId !== previous.accountId) return this.error(401, "identity_mismatch");
        next = { ...previous, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? previous.refreshToken, idToken: tokens.idToken ?? previous.idToken };
        if (!valid(next) || expiry(next.accessToken) <= Math.floor(Date.now() / 1000) + 60) return this.error(401, "session_invalid");
        await this.save(ACCOUNT_KEY, next);
        refreshed = true;
      } catch { return this.error(status === 401 || status === 403 ? status : 503, "refresh_unavailable"); }
    }
    if (force) return this.response({ refreshed, beforeExpiresAt: expiry(previous.accessToken), expiresAt: expiry(next.accessToken), accessTokenChanged: next.accessToken !== previous.accessToken, refreshTokenChanged: next.refreshToken !== previous.refreshToken, accountUnchanged: next.accountId === previous.accountId, deviceUnchanged: next.deviceId === previous.deviceId });
    return this.response({ accessToken: next.accessToken, deviceId: next.deviceId, refreshed });
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return this.error(404, "not_found");
    const path = new URL(request.url).pathname;
    try {
      if (path === "/login/start") return await this.exclusive(() => this.startLogin(request));
      if (path === "/login/complete") return await this.exclusive(() => this.completeLogin(request));
      if (path === "/status") return await this.exclusive(() => this.status());
      if (path === "/renew") return await this.exclusive(() => this.token(true));
      if (path !== "/token") return this.error(404, "not_found");
      if (!this.pendingToken) this.pendingToken = this.exclusive(() => this.token()).finally(() => { this.pendingToken = undefined; });
      return (await this.pendingToken).clone();
    } catch { return this.error(503, "credentials_unavailable"); }
  }
}

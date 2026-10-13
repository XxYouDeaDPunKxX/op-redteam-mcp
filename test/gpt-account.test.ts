import { afterEach, describe, expect, it, vi } from "vitest";
import * as worker from "../src/index";
import type { Env } from "../src/env";
import { base64UrlEncode, utf8 } from "../src/security/encoding";

const key = base64UrlEncode(new Uint8Array(32).fill(19));
const callback = "http://localhost:1455/auth/callback";
function jwt(exp: number, plan = "free") {
  return `${base64UrlEncode(utf8('{"alg":"none"}'))}.${base64UrlEncode(utf8(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "fixture-account" } })))}.fixture-signature`;
}
function tokens(exp: number, refresh = "fixture-refresh", plan = "free") {
  return { access_token: jwt(exp, plan), refresh_token: refresh, id_token: jwt(exp, plan), token_type: "Bearer", expires_in: 3600 };
}
function fixture() {
  const stored = new Map<string, unknown>();
  const state = { storage: { get: async (name: string) => stored.get(name), put: async (name: string, value: unknown) => { stored.set(name, value); }, delete: async (name: string) => stored.delete(name) } } as unknown as DurableObjectState;
  const env = { COOKIE_ENCRYPTION_KEY: key } as unknown as Env;
  const Constructor = Reflect.get(worker, "GptAccount");
  expect(typeof Constructor).toBe("function");
  const create = () => new Constructor(state, env) as { fetch(request: Request): Promise<Response> };
  const actor = create();
  const call = (path: string, body?: unknown, target = actor) => target.fetch(new Request(`https://internal${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { stored, actor, create, call };
}
async function login(f: ReturnType<typeof fixture>, exp = Math.floor(Date.now() / 1000) + 3600, plan = "free") {
  const start = await (await f.call("/login/start", { redirectUri: callback })).json() as { state: string };
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://auth.openai.com/oauth/token");
    expect(init?.redirect).toBe("manual");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(callback);
    expect(form.get("code")).toBe("fixture-code");
    expect(form.get("code_verifier")?.length).toBeGreaterThan(30);
    return Response.json(tokens(exp, "fixture-refresh", plan));
  });
  const response = await f.call("/login/complete", { code: "fixture-code", state: start.state });
  expect(response.status).toBe(200);
  return start;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("public encrypted ChatGPT credential owner", () => {
  it("uninitialized status exposes no token and token retrieval fails closed", async () => {
    const f = fixture();
    expect(await (await f.call("/status")).json()).toEqual({ initialized: false });
    expect((await f.call("/token")).status).toBe(503);
    expect(f.stored.size).toBe(0);
  });
  it("creates a PKCE login with a fixed loopback callback and encrypted pending state", async () => {
    const f = fixture();
    const response = await f.call("/login/start", { redirectUri: callback });
    expect(response.status).toBe(200);
    const body = await response.json() as { authorizationUrl: string; state: string };
    const url = new URL(body.authorizationUrl);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("redirect_uri")).toBe(callback);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.stringify([...f.stored.values()])).not.toContain(body.state);
    expect(body).not.toHaveProperty("codeVerifier");
  });
  it("rejects external redirect destinations before saving login state", async () => {
    const f = fixture();
    expect((await f.call("/login/start", { redirectUri: "https://attacker.example/callback" })).status).toBe(400);
    expect(f.stored.size).toBe(0);
  });
  it("rejects a mismatched callback state without contacting the token service", async () => {
    const f = fixture(); await f.call("/login/start", { redirectUri: callback });
    vi.stubGlobal("fetch", () => { throw new Error("State rejection must precede exchange"); });
    expect((await f.call("/login/complete", { code: "fixture-code", state: "wrong-state" })).status).toBe(401);
  });
  it.each(["free", "plus", "pro"])("stores %s account credentials encrypted and keeps tokens out of login/status responses", async plan => {
    const f = fixture(); const exp = Math.floor(Date.now() / 1000) + 3600;
    await login(f, exp, plan);
    const status = await (await f.call("/status")).json();
    expect(status).toMatchObject({ initialized: true, plan, expiresAt: exp });
    const statusText = JSON.stringify(status);
    expect(statusText).not.toContain(jwt(exp, plan)); expect(statusText).not.toContain("fixture-refresh");
    expect(statusText).not.toContain("fixture-account");
    const persisted = JSON.stringify([...f.stored.values()]);
    expect(persisted).not.toContain(jwt(exp, plan)); expect(persisted).not.toContain("fixture-refresh");
    vi.stubGlobal("fetch", () => { throw new Error("A valid access token must be reused"); });
    expect(await (await f.call("/token", undefined, f.create())).json()).toMatchObject({ accessToken: jwt(exp, plan), refreshed: false });
  });
  it("consumes callback state once so replay cannot replace credentials", async () => {
    const f = fixture(); const start = await login(f);
    const before = JSON.stringify([...f.stored.values()]);
    expect((await f.call("/login/complete", { code: "fixture-code", state: start.state })).status).toBe(401);
    expect(JSON.stringify([...f.stored.values()])).toBe(before);
  });
  it("coalesces automatic renewal near expiry and persists the rotated credential", async () => {
    const f = fixture(); await login(f, Math.floor(Date.now() / 1000) + 20);
    const next = Math.floor(Date.now() / 1000) + 7200; let calls = 0;
    vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "fixture-refresh" });
      calls++; await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json(tokens(next, "fixture-rotated"));
    });
    for (const response of await Promise.all([f.call("/token"), f.call("/token"), f.call("/token")])) expect(await response.json()).toMatchObject({ accessToken: jwt(next), refreshed: true });
    expect(calls).toBe(1);
    expect(await (await f.call("/token", undefined, f.create())).json()).toMatchObject({ accessToken: jwt(next), refreshed: false });
    expect(calls).toBe(1);
  });
  it("manual renewal uses the same storage path and returns only safe metadata", async () => {
    const f = fixture(); const before = Math.floor(Date.now() / 1000) + 3600; await login(f, before);
    const next = before + 3600;
    vi.stubGlobal("fetch", async () => Response.json(tokens(next, "fixture-rotated")));
    const proof = await (await f.call("/renew")).json();
    expect(proof).toMatchObject({ refreshed: true, beforeExpiresAt: before, expiresAt: next, accessTokenChanged: true, refreshTokenChanged: true });
    expect(JSON.stringify(proof)).not.toContain(jwt(next)); expect(JSON.stringify(proof)).not.toContain("fixture-rotated");
    expect(await (await f.call("/token")).json()).toMatchObject({ accessToken: jwt(next), refreshed: false });
  });
  it.each([401, 403, 302])("a failed renewal with HTTP %i preserves existing encrypted credentials", async status => {
    const f = fixture(); await login(f); const before = JSON.stringify([...f.stored.values()]);
    vi.stubGlobal("fetch", async () => new Response("private upstream error", { status, ...(status === 302 ? { headers: { Location: "https://other.example/" } } : {}) }));
    const response = await f.call("/renew");
    expect(response.status).toBe(status === 302 ? 503 : status);
    expect(await response.text()).not.toContain("private upstream error");
    expect(JSON.stringify([...f.stored.values()])).toBe(before);
  });
  it("rejects expired PKCE sessions before attempting code exchange", async () => {
    const f = fixture(); const start = await (await f.call("/login/start", { redirectUri: callback })).json() as { state: string };
    const clock = Date.now(); vi.spyOn(Date, "now").mockReturnValue(clock + 600_001);
    vi.stubGlobal("fetch", () => { throw new Error("Expired login must never exchange"); });
    expect((await f.call("/login/complete", { code: "fixture-code", state: start.state })).status).toBe(401);
  });
});

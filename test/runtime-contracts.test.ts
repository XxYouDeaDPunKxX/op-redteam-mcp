import { describe, expect, it, vi } from "vitest";

import { createDcrPolicy } from "../src/auth/dcr";
import {
  AUTHORIZE_COOKIE,
  CALLBACK_COOKIE,
  MAX_SET_COOKIE_BYTES,
  openCookie,
  sealCookie,
} from "../src/auth/cookies";
import { resolveRuntimeOrigin } from "../src/auth/origin";
import {
  authorizeEnvelopeSchema,
  callbackEnvelopeSchema,
  fromAuthRequest,
  toAuthRequest,
  validateFresh,
} from "../src/auth/transaction";
import { enforceIngress } from "../src/http/ingress";
import { base64UrlEncode } from "../src/security/encoding";
import { dcrRateKey, packetIdHash, reviewRateKey, sessionAffinity, subjectHash } from "../src/security/identity";

const key = base64UrlEncode(new Uint8Array(32).fill(7));

async function expectedHmac(tuple: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(tuple))));
}

describe("domain-separated identity derivation", () => {
  it("uses the exact review, DCR, and affinity tuples", async () => {
    await expect(reviewRateKey(key, 42)).resolves.toBe(await expectedHmac("review\0github:42\0adversarial_review"));
    await expect(dcrRateKey(key, "203.0.113.7")).resolves.toBe(await expectedHmac("dcr\0" + "203.0.113.7"));
    await expect(sessionAffinity(key, 42)).resolves.toBe(await expectedHmac("affinity\0github:42\0" + "1.0\0" + "1.0"));
  });

  it("keeps telemetry subject and packet hashes separate from rate keys", async () => {
    const [rate, subject, packet] = await Promise.all([
      reviewRateKey(key, 42),
      subjectHash(key, 42),
      packetIdHash(key, "packet-42"),
    ]);
    expect(new Set([rate, subject, packet]).size).toBe(3);
    expect(subject).toBe(await expectedHmac("telemetry-subject-v1\0github:42"));
    expect(packet).toBe(await expectedHmac("packet-id-v1\0packet-42"));
  });
});

describe("bounded HTTP ingress", () => {
  function post(path: string, body: BodyInit, headers: Record<string, string>): Request {
    return new Request(`https://op.example${path}`, { method: "POST", body, headers });
  }

  it.each([
    ["/mcp", 73_728, "application/json"],
    ["/register", 16_384, "application/json"],
    ["/token", 8_192, "application/x-www-form-urlencoded"],
    ["/authorize", 8_192, "application/x-www-form-urlencoded"],
  ])("allows exactly the %s body budget and rejects one octet above", async (path, limit, type) => {
    const exact = await enforceIngress(post(path, "x".repeat(limit), { "Content-Type": type }));
    expect(exact.kind).toBe("request");
    const above = await enforceIngress(post(path, "x".repeat(limit + 1), { "Content-Type": type }));
    expect(above.kind).toBe("response");
    if (above.kind === "response") expect(above.response.status).toBe(413);
  });

  it("uses a bounded reader without Content-Length and defeats a false smaller length", async () => {
    const noLength = post("/token", "x".repeat(8_193), { "Content-Type": "application/x-www-form-urlencoded" });
    const first = await enforceIngress(noLength);
    expect(first.kind === "response" && first.response.status).toBe(413);

    const falseLength = post("/authorize", "x".repeat(8_193), {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "1",
    });
    const second = await enforceIngress(falseLength);
    expect(second.kind === "response" && second.response.status).toBe(413);
  });

  it("rejects unsupported content encodings and media types", async () => {
    const encoded = await enforceIngress(
      post("/mcp", "{}", { "Content-Type": "application/json", "Content-Encoding": "gzip" }),
    );
    const wrongType = await enforceIngress(post("/mcp", "{}", { "Content-Type": "text/plain" }));
    expect(encoded.kind === "response" && encoded.response.status).toBe(415);
    expect(wrongType.kind === "response" && wrongType.response.status).toBe(415);
  });

  it("counts exact UTF-8 query octets", async () => {
    const exact = await enforceIngress(new Request(`https://op.example/authorize?${"a".repeat(8_192)}`));
    const above = await enforceIngress(new Request(`https://op.example/authorize?${"a".repeat(8_193)}`));
    const callback = await enforceIngress(new Request(`https://op.example/callback?${"é".repeat(2_049)}`));
    expect(exact.kind).toBe("request");
    expect(above.kind === "response" && above.response.status).toBe(414);
    expect(callback.kind === "response" && callback.response.status).toBe(414);
  });
});

describe("encrypted stateless transaction cookies", () => {
  it("round-trips a bounded envelope and emits the required attributes", async () => {
    const value = { value: "closed", issuedAt: 1, expiresAt: 2 };
    const header = await sealCookie(AUTHORIZE_COOKIE, "/authorize", value, key, "https://op.example");
    expect(header).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(header).toContain("Path=/authorize");
    expect(new TextEncoder().encode(header).byteLength).toBeLessThanOrEqual(MAX_SET_COOKIE_BYTES);
    const encoded = header.split(";", 1)[0]!.split("=").slice(1).join("=");
    await expect(openCookie(AUTHORIZE_COOKIE, "/authorize", encoded, key, "https://op.example")).resolves.toEqual(value);
  });

  it("fails closed on alteration, cross-cookie, cross-path, and cross-origin use", async () => {
    const header = await sealCookie(AUTHORIZE_COOKIE, "/authorize", { value: "x" }, key, "https://op.example");
    const encoded = header.split(";", 1)[0]!.split("=").slice(1).join("=");
    const altered = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
    await expect(openCookie(AUTHORIZE_COOKIE, "/authorize", altered, key, "https://op.example")).rejects.toThrow();
    await expect(openCookie(CALLBACK_COOKIE, "/authorize", encoded, key, "https://op.example")).rejects.toThrow();
    await expect(openCookie(AUTHORIZE_COOKIE, "/callback", encoded, key, "https://op.example")).rejects.toThrow();
    await expect(openCookie(AUTHORIZE_COOKIE, "/authorize", encoded, key, "https://other.example")).rejects.toThrow();
  });

  it("rejects plaintext larger than 2,048 UTF-8 bytes", async () => {
    await expect(sealCookie(AUTHORIZE_COOKIE, "/authorize", { value: "x".repeat(2_100) }, key, "https://op.example")).rejects.toThrow(
      "cookie_plaintext_too_large",
    );
  });
});

describe("authorization transaction envelopes", () => {
  const downstream = {
    responseType: "code" as const,
    clientId: "client-1",
    redirectUri: "https://client.example/oauth/callback",
    scope: ["review:invoke"] as ["review:invoke"],
    downstream_state: "s".repeat(43),
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256" as const,
    resource: "https://op.example",
  };

  it("reconstructs AuthRequest explicitly and preserves distinct state names", () => {
    const parsed = fromAuthRequest(
      {
        responseType: "code",
        clientId: downstream.clientId,
        redirectUri: downstream.redirectUri,
        scope: ["review:invoke"],
        state: downstream.downstream_state,
        codeChallenge: downstream.codeChallenge,
        codeChallengeMethod: "S256",
        resource: downstream.resource,
      },
      downstream.resource,
    );
    expect(toAuthRequest(parsed)).toMatchObject({ state: downstream.downstream_state, resource: downstream.resource });
  });

  it("rejects additional properties, wrong scopes, wrong resource, and expired lifetimes", () => {
    expect(
      authorizeEnvelopeSchema.safeParse({
        downstream_authorization_request: downstream,
        csrf_state: "x".repeat(43),
        issuedAt: 100,
        expiresAt: 700,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      callbackEnvelopeSchema.safeParse({
        downstream_authorization_request: { ...downstream, scope: ["other"] },
        upstream_github_state: "u".repeat(43),
        github_pkce_verifier: "v".repeat(43),
        issuedAt: 100,
        expiresAt: 700,
      }).success,
    ).toBe(false);
    expect(() =>
      fromAuthRequest(
        {
          responseType: "code",
          clientId: downstream.clientId,
          redirectUri: downstream.redirectUri,
          scope: ["review:invoke"],
          state: downstream.downstream_state,
          codeChallenge: downstream.codeChallenge,
          codeChallengeMethod: "S256",
          resource: "https://wrong.example",
        },
        downstream.resource,
      ),
    ).toThrow("resource_mismatch");
    expect(() => validateFresh({ issuedAt: 100, expiresAt: 200 }, 201)).toThrow("expired_transaction");
  });
});

describe("closed DCR policy", () => {
  const allowed = "https://client.example/oauth/callback";
  const request = new Request("https://op.example/register", { method: "POST", body: "{}" });
  const valid = {
    redirect_uris: [allowed],
    token_endpoint_auth_method: "none",
    client_name: "Test MCP client",
    client_uri: "https://client.example",
    contacts: ["security@example.com"],
    scope: "review:invoke",
  };

  it("accepts the minimal generic MCP client registration shape and provider defaults", () => {
    expect(createDcrPolicy(allowed)({ clientMetadata: valid, request })).toBeUndefined();
  });

  it("accepts explicit authorization-code and refresh-token metadata", () => {
    expect(
      createDcrPolicy(allowed)({
        clientMetadata: {
          ...valid,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        request,
      }),
    ).toBeUndefined();
  });

  it.each([
    { redirect_uris: [allowed, "https://evil.example"] },
    { redirect_uris: ["https://evil.example"] },
    { grant_types: ["implicit"] },
    { response_types: ["token"] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { scope: "review:invoke repo" },
    { software_statement: "jwt" },
    { jwks_uri: "https://client.example/jwks" },
    { client_uri: "http://client.example" },
    { client_name: "x".repeat(257) },
    { contacts: Array.from({ length: 6 }, () => "a@example.com") },
  ])("rejects a forbidden metadata class", (change) => {
    const result = createDcrPolicy(allowed)({ clientMetadata: { ...valid, ...change }, request });
    expect(result).toMatchObject({ code: "invalid_client_metadata", status: 400 });
  });
});

describe("canonical public origin", () => {
  it("derives resource and endpoints from one exact HTTPS origin", () => {
    expect(resolveRuntimeOrigin("https://op.example")).toEqual({
      publicOrigin: "https://op.example",
      mcpResource: "https://op.example",
      mcpEndpoint: "https://op.example/mcp",
      authorizeEndpoint: "https://op.example/authorize",
      tokenEndpoint: "https://op.example/token",
      registerEndpoint: "https://op.example/register",
      callbackEndpoint: "https://op.example/callback",
    });
  });

  it.each(["http://op.example", "https://op.example/", "https://OP.example", "https://op.example/path", "https://op.example?x=1"])(
    "rejects non-canonical origin %s",
    (value) => expect(() => resolveRuntimeOrigin(value)).toThrow("invalid_public_origin"),
  );

  it("allows HTTP only for explicit localhost test mode", () => {
    expect(resolveRuntimeOrigin("http://localhost:8787", true).publicOrigin).toBe("http://localhost:8787");
  });

  it("requires MCP_RESOURCE to be the exact canonical public origin", () => {
    expect(() => resolveRuntimeOrigin("https://op.example", false, "https://other.example")).toThrow("resource_origin_mismatch");
    expect(() => resolveRuntimeOrigin("https://op.example", false, "https://op.example/")).toThrow("invalid_mcp_resource");
  });
});

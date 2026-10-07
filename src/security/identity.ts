import { base64UrlDecode, base64UrlEncode, utf8 } from "./encoding";

const keyCache = new Map<string, CryptoKey>();
const LEGACY_REVIEW_RATE_SCOPE = "adversarial_review";
const LEGACY_AFFINITY_PROTOCOL = "1.0\u00001.0";

async function importHmacKey(encoded: string): Promise<CryptoKey> {
  const existing = keyCache.get(encoded);
  if (existing) return existing;
  const bytes = base64UrlDecode(encoded);
  if (bytes.byteLength < 32) throw new TypeError("identity_hmac_key_too_short");
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  keyCache.set(encoded, key);
  return key;
}

export async function hmacDigest(key: string, domain: string, boundedValue: string): Promise<string> {
  if (boundedValue.length > 512) throw new TypeError("hmac_input_too_long");
  const imported = await importHmacKey(key);
  const signature = await crypto.subtle.sign("HMAC", imported, utf8(`${domain}\0${boundedValue}`));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function reviewRateKey(key: string, githubUserId: number): Promise<string> {
  return hmacDigest(key, "review", `github:${githubUserId}\0${LEGACY_REVIEW_RATE_SCOPE}`);
}

export async function dcrRateKey(key: string, canonicalIp: string): Promise<string> {
  return hmacDigest(key, "dcr", canonicalIp);
}

export async function packetIdHash(key: string, packetId: string): Promise<string> {
  return hmacDigest(key, "packet-id-v1", packetId.slice(0, 128));
}

export async function subjectHash(key: string, githubUserId: number): Promise<string> {
  return hmacDigest(key, "telemetry-subject-v1", `github:${githubUserId}`);
}

export async function sessionAffinity(key: string, githubUserId: number): Promise<string> {
  return hmacDigest(key, "affinity", `github:${githubUserId}\u0000${LEGACY_AFFINITY_PROTOCOL}`);
}

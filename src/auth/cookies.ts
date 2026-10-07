import { canonicalizeJson } from "../contracts/canonical-json";
import { base64UrlDecode, base64UrlEncode, utf8 } from "../security/encoding";

export const AUTHORIZE_COOKIE = "__Secure-op_authorize_v1";
export const CALLBACK_COOKIE = "__Secure-op_callback_v1";
export const MAX_COOKIE_PLAINTEXT_BYTES = 2_048;
export const MAX_SET_COOKIE_BYTES = 3_799;

const keyCache = new Map<string, CryptoKey>();

async function importEncryptionKey(encoded: string): Promise<CryptoKey> {
  const cached = keyCache.get(encoded);
  if (cached) return cached;
  const bytes = base64UrlDecode(encoded);
  if (bytes.byteLength < 32) throw new TypeError("cookie_key_too_short");
  const key = await crypto.subtle.importKey("raw", bytes.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  keyCache.set(encoded, key);
  return key;
}

function aad(name: string, path: string, origin: string): Uint8Array<ArrayBuffer> {
  return utf8(`op-redteam-cookie-v1\0${name}\0${path}\0${origin}`);
}

function cookieHeader(name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return undefined;
}

export function clearCookie(name: string, path: string): string {
  return cookieHeader(name, "", path, 0);
}

export async function sealCookie(
  name: string,
  path: string,
  value: unknown,
  encodedKey: string,
  origin: string,
): Promise<string> {
  const plaintext = canonicalizeJson(value).bytes;
  if (plaintext.byteLength > MAX_COOKIE_PLAINTEXT_BYTES) throw new TypeError("cookie_plaintext_too_large");
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const key = await importEncryptionKey(encodedKey);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name, path, origin) }, key, plaintext);
  const encoded = `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
  const header = cookieHeader(name, encoded, path, 600);
  if (utf8(header).byteLength > MAX_SET_COOKIE_BYTES) throw new TypeError("set_cookie_too_large");
  return header;
}

export async function openCookie(
  name: string,
  path: string,
  encoded: string,
  encodedKey: string,
  origin: string,
): Promise<unknown> {
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new TypeError("invalid_cookie");
  const iv = base64UrlDecode(parts[1] ?? "");
  const ciphertext = base64UrlDecode(parts[2] ?? "");
  if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new TypeError("invalid_cookie");
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad(name, path, origin) },
    key,
    ciphertext,
  );
  const bytes = new Uint8Array(plaintext);
  if (bytes.byteLength > MAX_COOKIE_PLAINTEXT_BYTES) throw new TypeError("invalid_cookie");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

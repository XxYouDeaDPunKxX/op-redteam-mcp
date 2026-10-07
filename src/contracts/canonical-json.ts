import { canonicalize } from "json-canonicalize";

import type { JsonValue } from "./types";

const encoder = new TextEncoder();

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertIJson(value: unknown, seen: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new TypeError("non_canonicalizable_json");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_canonicalizable_json");
    return;
  }
  if (typeof value !== "object") throw new TypeError("non_canonicalizable_json");
  if (seen.has(value)) throw new TypeError("non_canonicalizable_json");
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) assertIJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("non_canonicalizable_json");
    }
    for (const [key, item] of Object.entries(value)) {
      if (hasLoneSurrogate(key)) throw new TypeError("non_canonicalizable_json");
      assertIJson(item, seen);
    }
  }

  seen.delete(value);
}

export interface CanonicalJson {
  text: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export function canonicalizeJson(value: unknown): CanonicalJson {
  assertIJson(value, new Set<object>());
  const text = canonicalize(value);
  return { text, bytes: encoder.encode(text) };
}

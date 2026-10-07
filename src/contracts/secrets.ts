const SECRET_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { category: "bearer_token_like", pattern: /\bauthorization\s*:\s*bearer\s+[a-z0-9._~+/=-]{16,}/i },
  { category: "bearer_token_like", pattern: /\bbearer\s+[a-z0-9._~+/=-]{16,}/i },
  { category: "github_token_like", pattern: /\bgh[pousr]_[a-z0-9]{20,}\b/i },
  { category: "openai_key_like", pattern: /\bsk-[a-z0-9_-]{20,}\b/i },
  { category: "aws_access_key_like", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: "slack_token_like", pattern: /\bxox[baprs]-[a-z0-9-]{10,}\b/i },
  { category: "slack_token_like", pattern: /\bxapp-[0-9]+-[a-z0-9-]{10,}\b/i },
  { category: "stripe_secret_key_like", pattern: /\b[rs]k_(?:live|test)_[a-z0-9]{16,}\b/i },
  { category: "sendgrid_key_like", pattern: /\bSG\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i },
  { category: "jwt_like", pattern: /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{16,}\b/i },
  { category: "google_api_key_like", pattern: /\bAIza[0-9a-z_-]{35}\b/i },
  {
    category: "azure_storage_key_like",
    pattern: /\bDefaultEndpointsProtocol=https?;[^\r\n]{0,512}\bAccountKey=[a-z0-9+/=]{20,}/i,
  },
  {
    category: "azure_sas_like",
    pattern: /(?:[?&;]|\b)(?:sv=[^\s;&]{4,}[;&][^\s]{0,1024}[;&]sig=|sig=[a-z0-9%+/=_-]{16,}[^\s]{0,1024}[;&]sv=)/i,
  },
  {
    category: "credential_assignment",
    pattern:
      /\b(?:(?:aws|azure|slack|stripe|twilio|sendgrid|google|openai)[_-])?(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|auth[_-]?token|secret[_-]?access[_-]?key|signing[_-]?secret|webhook[_-]?secret|account[_-]?key|storage[_-]?key|storage[_-]?sas[_-]?token|sas[_-]?token)\s*[:=]\s*["']?[a-z0-9._~%+/?&;=-]{16,}/i,
  },
  { category: "credential_connection_string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{8,}@/i },
];

export interface SecretMatch {
  category: string;
  location: string;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function findSecretLikeValue(value: unknown, location = ""): SecretMatch | undefined {
  if (typeof value === "string") {
    const match = SECRET_PATTERNS.find(({ pattern }) => pattern.test(value));
    return match ? { category: match.category, location: location || "/" } : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findSecretLikeValue(value[index], `${location}/${index}`);
      if (result) return result;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const result = findSecretLikeValue(item, `${location}/${escapePointer(key)}`);
      if (result) return result;
    }
  }
  return undefined;
}

import type {
  ClientRegistrationCallbackOptions,
  ClientRegistrationCallbackResult,
} from "@cloudflare/workers-oauth-provider";

const ALLOWED_FIELDS = new Set([
  "redirect_uris",
  "grant_types",
  "response_types",
  "token_endpoint_auth_method",
  "client_name",
  "client_uri",
  "logo_uri",
  "tos_uri",
  "policy_uri",
  "contacts",
  "scope",
]);

function reject(description = "registration metadata rejected"): ClientRegistrationCallbackResult {
  return { code: "invalid_client_metadata", description, status: 400 };
}

function exactSet(value: unknown, allowed: string[][], optional = false): boolean {
  if (value === undefined) return optional;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false;
  const normalized = [...new Set(value as string[])].sort();
  return allowed.some((candidate) => candidate.length === normalized.length && candidate.every((item, index) => item === normalized[index]));
}

function optionalHttpsUri(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function createDcrPolicy(allowedRedirectUrisCsv: string) {
  const allowedRedirectUris = new Set(allowedRedirectUrisCsv.split(",").map((value) => value.trim()).filter(Boolean));
  return ({ clientMetadata }: ClientRegistrationCallbackOptions): ClientRegistrationCallbackResult | undefined => {
    try {
      if (allowedRedirectUris.size === 0) return reject();
      if (Object.keys(clientMetadata).some((key) => !ALLOWED_FIELDS.has(key))) return reject();
      const redirects = clientMetadata.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length !== 1 || typeof redirects[0] !== "string") return reject();
      if (!allowedRedirectUris.has(redirects[0])) return reject();
      if (!exactSet(clientMetadata.grant_types, [["authorization_code"], ["authorization_code", "refresh_token"]], true)) {
        return reject();
      }
      if (!exactSet(clientMetadata.response_types, [["code"]], true)) return reject();
      if (clientMetadata.token_endpoint_auth_method !== "none") return reject();
      if (
        clientMetadata.scope !== undefined &&
        (typeof clientMetadata.scope !== "string" ||
          clientMetadata.scope.split(/\s+/).filter(Boolean).sort().join(" ") !== "review:invoke")
      ) {
        return reject();
      }
      if (clientMetadata.client_name !== undefined && (typeof clientMetadata.client_name !== "string" || clientMetadata.client_name.length > 256)) {
        return reject();
      }
      for (const field of ["client_uri", "logo_uri", "tos_uri", "policy_uri"] as const) {
        if (!optionalHttpsUri(clientMetadata[field])) return reject();
      }
      const contacts = clientMetadata.contacts;
      if (
        contacts !== undefined &&
        (!Array.isArray(contacts) || contacts.length > 5 || contacts.some((item) => typeof item !== "string" || item.length > 320))
      ) {
        return reject();
      }
      return undefined;
    } catch {
      return { code: "server_error", description: "registration policy unavailable", status: 500 };
    }
  };
}

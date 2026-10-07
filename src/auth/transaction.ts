import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

const boundedToken = z.string().min(1).max(512);
const downstreamSchema = z
  .object({
    responseType: z.literal("code"),
    clientId: boundedToken,
    redirectUri: z.url().max(2048),
    scope: z.tuple([z.literal("review:invoke")]),
    downstream_state: boundedToken,
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    codeChallengeMethod: z.literal("S256"),
    resource: z.string().max(2048),
  })
  .strict();

const lifetime = z
  .object({ issuedAt: z.int().nonnegative(), expiresAt: z.int().positive() })
  .refine((value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 600);

export const authorizeEnvelopeSchema = z
  .object({
    downstream_authorization_request: downstreamSchema,
    csrf_state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    issuedAt: lifetime.shape.issuedAt,
    expiresAt: lifetime.shape.expiresAt,
  })
  .strict()
  .refine((value) => lifetime.safeParse({ issuedAt: value.issuedAt, expiresAt: value.expiresAt }).success);

export const callbackEnvelopeSchema = z
  .object({
    downstream_authorization_request: downstreamSchema,
    upstream_github_state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    github_pkce_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    issuedAt: lifetime.shape.issuedAt,
    expiresAt: lifetime.shape.expiresAt,
  })
  .strict()
  .refine((value) => lifetime.safeParse({ issuedAt: value.issuedAt, expiresAt: value.expiresAt }).success);

export type DownstreamAuthorizationRequest = z.infer<typeof downstreamSchema>;
export type AuthorizeEnvelope = z.infer<typeof authorizeEnvelopeSchema>;
export type CallbackEnvelope = z.infer<typeof callbackEnvelopeSchema>;

export function validateFresh<T extends { issuedAt: number; expiresAt: number }>(value: T, nowSeconds: number): T {
  if (value.issuedAt > nowSeconds + 5 || value.expiresAt < nowSeconds) throw new TypeError("expired_transaction");
  return value;
}

export function fromAuthRequest(request: AuthRequest, canonicalResource: string): DownstreamAuthorizationRequest {
  const parsed = downstreamSchema.parse({
    responseType: request.responseType,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scope: request.scope,
    downstream_state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    resource: request.resource,
  });
  if (parsed.resource !== canonicalResource) throw new TypeError("resource_mismatch");
  return parsed;
}

export function toAuthRequest(value: DownstreamAuthorizationRequest): AuthRequest {
  return {
    responseType: value.responseType,
    clientId: value.clientId,
    redirectUri: value.redirectUri,
    scope: [...value.scope],
    state: value.downstream_state,
    codeChallenge: value.codeChallenge,
    codeChallengeMethod: value.codeChallengeMethod,
    resource: value.resource,
  };
}

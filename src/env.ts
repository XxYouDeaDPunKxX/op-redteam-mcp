import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { LogSinkConfig } from "./log-sink";
import type { AiBinding } from "./providers/common";

export interface Env extends LogSinkConfig {
  AI: AiBinding;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  RATE_LIMITER: RateLimit;
  ANALYTICS: AnalyticsEngineDataset;
  VERSION_METADATA: { id: string; tag: string; timestamp: string };
  PUBLIC_ORIGIN: string;
  MCP_RESOURCE: string;
  AUTH_MODE?: "github" | "none";
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USER_IDS: string;
  ALLOWED_DCR_REDIRECT_URIS: string;
  COOKIE_ENCRYPTION_KEY: string;
  IDENTITY_HMAC_KEY: string;
  COGNITIVE_RUNTIME_PROFILE?: "external" | "cloudflare_rollback";
  OPENROUTER_API_KEY?: string;
  NVIDIA_API_KEY?: string;
}

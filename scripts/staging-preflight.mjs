import { unstable_readConfig } from "wrangler";
import path from "node:path";
import { validateStagingTemplateValues } from "./staging-preflight-values.mjs";

const REQUIRED_SECRETS = [
  "COOKIE_ENCRYPTION_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "IDENTITY_HMAC_KEY",
  "OPENROUTER_API_KEY",
  "NVIDIA_API_KEY",
];

const SECRET_NAMES = new Set(REQUIRED_SECRETS);
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function exactlyOne(items, predicate) {
  return Array.isArray(items) && items.length === 1 && predicate(items[0]);
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

const config = unstable_readConfig(
  { config: "wrangler.jsonc", env: "staging" },
  { hideWarnings: true },
);

check(
  typeof config.name === "string" &&
    (config.name === "op-redteam-mcp" || config.name.startsWith("op-redteam-mcp-")),
  "Worker name must remain derived from op-redteam-mcp",
);
check(!config.account_id, "account_id must be supplied by the operator, not committed to the template");
check(config.main === path.resolve("src/index.ts"), "Worker entry point changed");
check(config.compatibility_date === "2026-07-13", "compatibility date changed");
check(sameStrings(config.compatibility_flags, ["nodejs_compat"]), "compatibility flags must remain closed to nodejs_compat");
check(config.workers_dev === true, "the canonical workers.dev route must be enabled");
check(config.preview_urls === false, "preview URLs must be disabled");
check(!config.routes || config.routes.length === 0, "staging must not expose a custom domain or zone route");

check(config.vars?.AUTH_MODE === "github", "AUTH_MODE must be github");
failures.push(...validateStagingTemplateValues(config));
check(config.vars?.COGNITIVE_RUNTIME_PROFILE === "external", "COGNITIVE_RUNTIME_PROFILE must select the external production route");
check(config.vars?.LOG_SINK_ENABLED === "false", "LOG_SINK_ENABLED must remain disabled in the committed staging template");
check(typeof config.vars?.LOG_SINK_URL === "string" && config.vars.LOG_SINK_URL.startsWith("https://"), "LOG_SINK_URL must be an HTTPS endpoint");
for (const name of SECRET_NAMES) {
  check(!(name in (config.vars ?? {})), `${name} must not be stored as a plain-text var`);
}
check(sameStrings(config.secrets?.required, REQUIRED_SECRETS), "required Worker secret declaration is incomplete");

check(
  config.define?.Cloudflare === '{"compatibilityFlags":{"global_fetch_strictly_public":true}}',
  "the provider-only Cloudflare build define changed",
);
check(config.ai?.binding === "AI", "Workers AI binding is missing");
check(
  exactlyOne(config.ratelimits, (binding) =>
    binding.name === "RATE_LIMITER" &&
    typeof binding.namespace_id === "string" &&
    binding.simple?.limit === 6 &&
    binding.simple?.period === 60),
  "RATE_LIMITER configuration is incomplete",
);
check(
  exactlyOne(config.analytics_engine_datasets, (binding) =>
    binding.binding === "ANALYTICS" && typeof binding.dataset === "string" && binding.dataset.length > 0),
  "Analytics Engine dataset is missing",
);
check(config.version_metadata?.binding === "VERSION_METADATA", "version metadata binding is missing");
check(!config.services || config.services.length === 0, "private service bindings must not be part of the public template");
check(sameStrings(config.triggers?.crons, ["17 3 * * *"]), "OAuth cleanup cron changed");

if (failures.length > 0) {
  console.error("Staging preflight failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Staging preflight passed: configuration is closed and no deploy was performed.");
}

import {
  normalizeThrown,
  type AiBinding,
  type ProviderAdapterOutcome,
  type ProviderUsage,
} from "../providers/common";
import type { Env } from "../env";
import {
  buildCloudflareRollbackRequest,
  buildNvidiaRequest,
  buildOpenRouterPremortemRequest,
  buildOpenRouterPremortemScanRequest,
  buildOpenRouterRequest,
  GPT_OSS_ROLLBACK_MODEL,
  type AdversarialReviewInput,
  type AbusePathInput,
  type PremortemTraceInput,
  type PremortemScanInput,
  type RedteamExperimentInput,
  type SparringInput,
  type SparringPressureInput,
  type SparringScanInput,
  type SparringToolName,
  type StressStructureInput,
} from "./request";

export const PROVIDER_DEADLINE_MS = 150_000;
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

type RuntimeProfile = "external" | "cloudflare_rollback";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function envelopeFailure(
  category: string,
  status: "critic_unavailable" | "critic_failed",
  latencyMs: number,
  phase: "critic" | "runtime" = "critic",
): ProviderAdapterOutcome {
  return { kind: "failure", status, category, phase, latencyMs };
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function httpFailure(status: number, latencyMs: number): ProviderAdapterOutcome {
  if (status === 408) return envelopeFailure("provider_timeout", "critic_unavailable", latencyMs, "runtime");
  if (status === 404) return envelopeFailure("provider_not_found", "critic_unavailable", latencyMs, "runtime");
  if (status === 429) return envelopeFailure("provider_rate_limited", "critic_unavailable", latencyMs, "runtime");
  if (status === 502) return envelopeFailure("provider_bad_gateway", "critic_unavailable", latencyMs, "runtime");
  if (status === 503) return envelopeFailure("provider_service_unavailable", "critic_unavailable", latencyMs, "runtime");
  if (status === 504) return envelopeFailure("provider_gateway_timeout", "critic_unavailable", latencyMs, "runtime");
  if (status >= 500) return envelopeFailure("provider_server_error", "critic_unavailable", latencyMs, "runtime");
  if (status === 401 || status === 403) {
    return envelopeFailure("provider_authentication", "critic_failed", latencyMs, "runtime");
  }
  return envelopeFailure("invalid_provider_request", "critic_failed", latencyMs, "runtime");
}

function chatErrorFailure(value: unknown, latencyMs: number): ProviderAdapterOutcome {
  if (!isRecord(value) || !isRecord(value.metadata) || typeof value.metadata.error_type !== "string") {
    return envelopeFailure("provider_error_envelope", "critic_unavailable", latencyMs);
  }
  const categories: Readonly<Record<string, readonly [string, "critic_unavailable" | "critic_failed"]>> = {
    authentication: ["provider_authentication", "critic_failed"],
    permission_denied: ["provider_authentication", "critic_failed"],
    payment_required: ["quota", "critic_unavailable"],
    rate_limit_exceeded: ["provider_rate_limited", "critic_unavailable"],
    provider_overloaded: ["provider_service_unavailable", "critic_unavailable"],
    provider_unavailable: ["provider_bad_gateway", "critic_unavailable"],
    timeout: ["provider_gateway_timeout", "critic_unavailable"],
    server: ["provider_server_error", "critic_unavailable"],
    unmapped: ["provider_server_error", "critic_unavailable"],
    not_found: ["provider_not_found", "critic_unavailable"],
    invalid_request: ["invalid_provider_request", "critic_failed"],
    invalid_prompt: ["invalid_provider_request", "critic_failed"],
    precondition_failed: ["invalid_provider_request", "critic_failed"],
    payload_too_large: ["invalid_provider_request", "critic_failed"],
    unprocessable: ["invalid_provider_request", "critic_failed"],
    content_policy_violation: ["model_refusal", "critic_unavailable"],
    refusal: ["model_refusal", "critic_unavailable"],
  };
  const classification = categories[value.metadata.error_type];
  if (!classification) return envelopeFailure("provider_error_envelope", "critic_unavailable", latencyMs);
  return envelopeFailure(classification[0], classification[1], latencyMs);
}

function parseResponsesUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = value.input_tokens;
  const output = value.output_tokens;
  const details = value.input_tokens_details;
  const cached = isRecord(details) ? (details.cached_tokens ?? 0) : 0;
  if (![input, output, cached].every(validCount)) return undefined;
  return {
    input_tokens: input as number,
    cached_input_tokens: cached as number,
    output_tokens: output as number,
  };
}

function parseOpenRouterUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = value.prompt_tokens;
  const output = value.completion_tokens;
  const details = value.prompt_tokens_details;
  const cached = isRecord(details) ? (details.cached_tokens ?? 0) : 0;
  if (![input, output, cached].every(validCount)) return undefined;
  return {
    input_tokens: input as number,
    cached_input_tokens: cached as number,
    output_tokens: output as number,
  };
}

export function validateResponsesEnvelope(value: unknown, latencyMs: number): ProviderAdapterOutcome {
  if (!isRecord(value)) return envelopeFailure("invalid_response_object", "critic_failed", latencyMs);
  if (value.object !== "response") return envelopeFailure("unexpected_response_type", "critic_failed", latencyMs);
  if (!Array.isArray(value.output)) return envelopeFailure("missing_output", "critic_failed", latencyMs);
  if (value.error !== null && value.error !== undefined) {
    return envelopeFailure("provider_unavailable", "critic_unavailable", latencyMs);
  }
  if (value.status === "incomplete" || (value.incomplete_details !== null && value.incomplete_details !== undefined)) {
    return envelopeFailure("truncated_output", "critic_failed", latencyMs);
  }
  if (value.status === "failed") return envelopeFailure("provider_unavailable", "critic_unavailable", latencyMs);
  if (value.status !== "completed") return envelopeFailure("unexpected_finish_reason", "critic_failed", latencyMs);

  const messages: Array<Record<string, unknown>> = [];
  for (const item of value.output) {
    if (!isRecord(item) || typeof item.type !== "string") {
      return envelopeFailure("invalid_output_item", "critic_failed", latencyMs);
    }
    if (item.type === "reasoning") continue;
    if (item.type !== "message") return envelopeFailure("unexpected_tool_call", "critic_failed", latencyMs);
    messages.push(item);
  }
  if (messages.length !== 1) return envelopeFailure("unexpected_message_count", "critic_failed", latencyMs);

  const message = messages[0]!;
  if (message.role !== "assistant" || (message.status !== undefined && message.status !== "completed") || !Array.isArray(message.content)) {
    return envelopeFailure("invalid_message", "critic_failed", latencyMs);
  }
  if (message.content.some((part) => isRecord(part) && part.type === "refusal")) {
    return envelopeFailure("model_refusal", "critic_unavailable", latencyMs);
  }
  if (message.content.length !== 1) return envelopeFailure("unexpected_content_count", "critic_failed", latencyMs);
  const part = message.content[0];
  if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
    return envelopeFailure("invalid_content_part", "critic_failed", latencyMs);
  }
  if (part.text.trim().length === 0) return envelopeFailure("empty_output", "critic_failed", latencyMs);
  const usage = parseResponsesUsage(value.usage);
  return { kind: "candidate", content: part.text, latencyMs, ...(usage ? { usage } : {}) };
}

export function validateOpenRouterEnvelope(value: unknown, latencyMs: number): ProviderAdapterOutcome {
  if (!isRecord(value)) return envelopeFailure("invalid_response_object", "critic_failed", latencyMs);
  if (value.error !== null && value.error !== undefined) {
    return chatErrorFailure(value.error, latencyMs);
  }
  if (!Array.isArray(value.choices)) return envelopeFailure("missing_choices", "critic_failed", latencyMs);
  if (value.choices.length !== 1) return envelopeFailure("unexpected_choice_count", "critic_failed", latencyMs);
  const choice = value.choices[0];
  if (!isRecord(choice)) return envelopeFailure("invalid_choice", "critic_failed", latencyMs);
  if (!isRecord(choice.message)) return envelopeFailure("missing_message", "critic_failed", latencyMs);
  const finish = choice.finish_reason;
  if (finish === "length") return envelopeFailure("truncated_output", "critic_failed", latencyMs);
  if (finish === "content_filter") return envelopeFailure("model_refusal", "critic_unavailable", latencyMs);
  if (finish === "tool_calls" || finish === "function_call") {
    return envelopeFailure("unexpected_tool_call", "critic_failed", latencyMs);
  }
  if (finish !== "stop") return envelopeFailure("unexpected_finish_reason", "critic_failed", latencyMs);
  const message = choice.message;
  if (message.role !== undefined && message.role !== "assistant") {
    return envelopeFailure("unexpected_message_role", "critic_failed", latencyMs);
  }
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    return envelopeFailure("model_refusal", "critic_unavailable", latencyMs);
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return envelopeFailure("unexpected_tool_call", "critic_failed", latencyMs);
  }
  if (typeof message.content !== "string") return envelopeFailure("non_text_content", "critic_failed", latencyMs);
  if (message.content.trim().length === 0) return envelopeFailure("empty_output", "critic_failed", latencyMs);
  const usage = parseOpenRouterUsage(value.usage);
  return { kind: "candidate", content: message.content, latencyMs, ...(usage ? { usage } : {}) };
}

function profile(env: Env): RuntimeProfile | undefined {
  if (env.COGNITIVE_RUNTIME_PROFILE === "external" || env.COGNITIVE_RUNTIME_PROFILE === "cloudflare_rollback") {
    return env.COGNITIVE_RUNTIME_PROFILE;
  }
  if (env.AUTH_MODE === "none") return "cloudflare_rollback";
  return undefined;
}

export async function invokeCloudflareRollback(
  ai: AiBinding,
  tool: SparringToolName,
  input: SparringInput,
  affinity: string,
  now: () => number = Date.now,
): Promise<ProviderAdapterOutcome> {
  const started = now();
  const controller = new AbortController();
  let applicationDeadline = false;
  const timeout = setTimeout(() => {
    applicationDeadline = true;
    controller.abort();
  }, PROVIDER_DEADLINE_MS);
  try {
    const envelope = await ai.run(GPT_OSS_ROLLBACK_MODEL, buildCloudflareRollbackRequest(tool, input), {
      signal: controller.signal,
      extraHeaders: { "x-session-affinity": affinity },
    });
    return validateResponsesEnvelope(envelope, Math.max(0, now() - started));
  } catch (error: unknown) {
    return normalizeThrown(error, applicationDeadline, Math.max(0, now() - started));
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeOpenRouter(
  env: Env,
  tool: "abuse_path" | "premortem_trace" | "premortem_scan",
  input: AbusePathInput | PremortemTraceInput | PremortemScanInput,
  now: () => number,
  fetcher: typeof fetch,
): Promise<ProviderAdapterOutcome> {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return envelopeFailure("provider_configuration", "critic_failed", 0, "runtime");
  const started = now();
  const controller = new AbortController();
  let applicationDeadline = false;
  const timeout = setTimeout(() => {
    applicationDeadline = true;
    controller.abort();
  }, PROVIDER_DEADLINE_MS);
  try {
    const response = await fetcher(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "OP Adversarial Pressure",
      },
      body: JSON.stringify(
        tool === "premortem_trace"
          ? buildOpenRouterPremortemRequest(input as PremortemTraceInput)
          : tool === "premortem_scan"
            ? buildOpenRouterPremortemScanRequest(input as PremortemScanInput)
          : buildOpenRouterRequest(input as AbusePathInput),
      ),
      signal: controller.signal,
    });
    if (!response.ok) return httpFailure(response.status, Math.max(0, now() - started));
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { return envelopeFailure("invalid_json", "critic_failed", Math.max(0, now() - started)); }
    return validateOpenRouterEnvelope(envelope, Math.max(0, now() - started));
  } catch (error: unknown) {
    return normalizeThrown(error, applicationDeadline, Math.max(0, now() - started));
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeNvidia(
  env: Env,
  tool: SparringToolName,
  input: SparringInput,
  now: () => number,
  fetcher: typeof fetch,
): Promise<ProviderAdapterOutcome> {
  const key = env.NVIDIA_API_KEY?.trim();
  if (!key) return envelopeFailure("provider_configuration", "critic_failed", 0, "runtime");
  const started = now();
  const controller = new AbortController();
  let applicationDeadline = false;
  const timeout = setTimeout(() => {
    applicationDeadline = true;
    controller.abort();
  }, PROVIDER_DEADLINE_MS);
  try {
    const response = await fetcher(NVIDIA_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(buildNvidiaRequest(tool, input)),
      signal: controller.signal,
    });
    if (!response.ok) return httpFailure(response.status, Math.max(0, now() - started));
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { return envelopeFailure("invalid_json", "critic_failed", Math.max(0, now() - started)); }
    return validateOpenRouterEnvelope(envelope, Math.max(0, now() - started));
  } catch (error: unknown) {
    return normalizeThrown(error, applicationDeadline, Math.max(0, now() - started));
  } finally {
    clearTimeout(timeout);
  }
}

export async function invokeSparringModel(
  env: Env,
  tool: SparringToolName,
  input: SparringInput,
  affinity: string,
  now: () => number = Date.now,
  fetcher: typeof fetch = fetch,
): Promise<ProviderAdapterOutcome> {
  const selected = profile(env);
  if (!selected) return envelopeFailure("provider_configuration", "critic_failed", 0, "runtime");
  if (selected === "cloudflare_rollback") {
    if (tool === "sparring_scan") return envelopeFailure("provider_configuration", "critic_failed", 0, "runtime");
    return invokeCloudflareRollback(env.AI, tool, input, affinity, now);
  }
  if (tool === "stress_structure") {
    return invokeNvidia(env, tool, input as StressStructureInput, now, fetcher);
  }
  if (tool === "adversarial_review") {
    return invokeNvidia(env, tool, input as AdversarialReviewInput, now, fetcher);
  }
  if (tool === "sparring_pressure") {
    return invokeNvidia(env, tool, input as SparringPressureInput, now, fetcher);
  }
  if (tool === "sparring_scan") {
    return invokeNvidia(env, tool, input as SparringScanInput, now, fetcher);
  }
  if (tool === "redteam_experiment") {
    return invokeNvidia(env, tool, input as RedteamExperimentInput, now, fetcher);
  }
  if (tool === "premortem_trace") return invokeOpenRouter(env, tool, input as PremortemTraceInput, now, fetcher);
  if (tool === "premortem_scan") return invokeOpenRouter(env, tool, input as PremortemScanInput, now, fetcher);
  return invokeOpenRouter(env, "abuse_path", input as AbusePathInput, now, fetcher);
}

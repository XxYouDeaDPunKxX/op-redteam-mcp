import { findSecretLikeValue } from "../contracts/secrets";
import type { ReviewIdentity } from "../contracts/types";
import type { ProviderUsage } from "../providers/common";
import type { Env } from "../env";
import { reviewRateKey, sessionAffinity } from "../security/identity";
import { invokeSparringModel } from "./adapter";
import type {
  AbusePathInput,
  AdversarialReviewInput,
  PremortemScanInput,
  PremortemTraceInput,
  RedteamExperimentInput,
  SparringInput,
  SparringPressureInput,
  SparringScanInput,
  SparringToolName,
  StressStructureInput,
} from "./request";

export type SparringServiceResult =
  | { kind: "success"; text: string; providerLatencyMs: number; usage?: ProviderUsage }
  | { kind: "error"; code: string; diagnosticCode?: string; providerLatencyMs: number; usage?: ProviderUsage }
  | { kind: "rate_limited" };

export type ModelOutputDiagnostic =
  | "stress_empty"
  | "stress_shape_mismatch"
  | "stress_placeholder"
  | "stress_evidence_not_verbatim"
  | "review_empty"
  | "review_too_large"
  | "pressure_empty"
  | "pressure_not_single_line"
  | "pressure_prefix_mismatch"
  | "pressure_arrow_count"
  | "pressure_separator_count"
  | "pressure_empty_slot"
  | "scan_empty"
  | "scan_shape_mismatch"
  | "scan_placeholder"
  | "scan_mechanism_not_verbatim"
  | "scan_aspect_not_verbatim"
  | "scan_variation_invalid"
  | "scan_pressure_too_large"
  | "scan_pressure_depth"
  | "scan_too_large"
  | "experiment_empty"
  | "experiment_too_large"
  | "premortem_scan_empty"
  | "premortem_scan_too_large"
  | "trace_empty"
  | "trace_bounds_or_layout"
  | "trace_prefix_mismatch"
  | "trace_transition_shape"
  | "trace_condition_mismatch"
  | "trace_failure_mismatch"
  | "path_empty"
  | "path_bounds_or_layout"
  | "path_prefix_mismatch"
  | "path_transition_shape"
  | "path_access_mismatch"
  | "path_anchor_mismatch"
  | "path_missing_transition"
  | "secret_like_output"
  | "postflight_invariant_failure";

interface OutputInspection {
  accepted?: string;
  diagnostic?: ModelOutputDiagnostic;
}

function normalizeCandidate(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function inspectStressStructureOutput(value: string, artifactExcerpt: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate === "NO GROUNDED BREAK") return { accepted: candidate };
  if (candidate.length === 0) return { diagnostic: "stress_empty" };
  const block = "what_breaks: [^\\n]+\\nevidence: [^\\n]+";
  if (!new RegExp(`^${block}$`).test(candidate)) return { diagnostic: "stress_shape_mismatch" };
  const breaks = [...candidate.matchAll(/^what_breaks: (.+)$/gm)].map((match) => match[1] ?? "");
  if (breaks.length === 0 || breaks.some((item) => /^\[.*\]$/.test(item) || /^(?:no valid break|none)$/i.test(item))) {
    return { diagnostic: "stress_placeholder" };
  }
  const evidence = [...candidate.matchAll(/^evidence: (.+)$/gm)].map((match) => {
    const raw = match[1] ?? "";
    const pairs = new Map([
      ['"', '"'],
      ["'", "'"],
      ["“", "”"],
      ["‘", "’"],
    ]);
    const closing = pairs.get(raw[0] ?? "");
    return closing && raw.endsWith(closing) ? raw.slice(1, -1) : raw;
  });
  if (evidence.length === 0 || evidence.some((quote) => !quote || !artifactExcerpt.includes(quote))) {
    return { diagnostic: "stress_evidence_not_verbatim" };
  }
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: candidate };
}

export function validateStressStructureOutput(value: string, artifactExcerpt: string): string | undefined {
  return inspectStressStructureOutput(value, artifactExcerpt).accepted;
}

function inspectAdversarialReviewOutput(value: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate.length === 0) return { diagnostic: "review_empty" };
  if (candidate.length > 12_000) return { diagnostic: "review_too_large" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: candidate };
}

export function validateAdversarialReviewOutput(value: string): string | undefined {
  return inspectAdversarialReviewOutput(value).accepted;
}

function inspectSparringPressureOutput(value: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate.length === 0) return { diagnostic: "pressure_empty" };
  if (candidate.length > 600 || candidate.includes("\n") || candidate.includes("?")) {
    return { diagnostic: "pressure_not_single_line" };
  }
  if (!candidate.startsWith("mechanism: ")) return { diagnostic: "pressure_prefix_mismatch" };
  const mechanism = candidate.slice("mechanism: ".length);
  if ((mechanism.match(/->/g)?.length ?? 0) !== 1) return { diagnostic: "pressure_arrow_count" };
  const [variationBlock, outcome] = mechanism.split("->").map((part) => part.trim());
  if ((variationBlock?.match(/::/g)?.length ?? 0) !== 1) return { diagnostic: "pressure_separator_count" };
  const [property, variation] = (variationBlock ?? "").split("::").map((part) => part.trim());
  if (!property || !variation || !outcome) return { diagnostic: "pressure_empty_slot" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: `mechanism: ${property} :: ${variation} -> ${outcome}` };
}

export function validateSparringPressureOutput(value: string, _targetQuote?: string): string | undefined {
  return inspectSparringPressureOutput(value).accepted;
}

function inspectSparringScanOutput(value: string, idea: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate === "NO GROUNDED PRESSURE") return { accepted: candidate };
  if (candidate.length === 0) return { diagnostic: "scan_empty" };
  if (candidate.length > 1_800) return { diagnostic: "scan_too_large" };
  if (candidate.includes("?")) return { diagnostic: "scan_shape_mismatch" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };

  const prefixes = ["MECHANISM: ", "ASPECT: ", "VARIATION: ", "PRESSURE: "] as const;
  const lines = candidate.split("\n");
  if (lines.length !== prefixes.length || lines.some((line, index) => !line.startsWith(prefixes[index]!))) {
    return { diagnostic: "scan_shape_mismatch" };
  }

  const [mechanism, aspect, variation, pressure] = lines.map((line, index) => line.slice(prefixes[index]!.length).trim());
  if ([mechanism, aspect, variation, pressure].some((field) => !field || /^\[.*\]$/u.test(field!))) {
    return { diagnostic: "scan_placeholder" };
  }
  if (mechanism!.length > 500 || !idea.includes(mechanism!)) {
    return { diagnostic: "scan_mechanism_not_verbatim" };
  }
  if (aspect!.length > 300 || !idea.includes(aspect!)) {
    return { diagnostic: "scan_aspect_not_verbatim" };
  }
  if (variation!.length > 300 || variation!.includes("->") || variation === aspect) {
    return { diagnostic: "scan_variation_invalid" };
  }
  if (pressure!.length > 600) {
    return { diagnostic: "scan_pressure_too_large" };
  }
  if ((pressure!.match(/->/gu)?.length ?? 0) > 1) {
    return { diagnostic: "scan_pressure_depth" };
  }
  return { accepted: candidate };
}

export function validateSparringScanOutput(value: string, idea: string): string | undefined {
  return inspectSparringScanOutput(value, idea).accepted;
}

function inspectRedteamExperimentOutput(value: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate.length === 0) return { diagnostic: "experiment_empty" };
  if (candidate.length > 6_000) return { diagnostic: "experiment_too_large" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: candidate };
}

export function validateRedteamExperimentOutput(value: string): string | undefined {
  return inspectRedteamExperimentOutput(value).accepted;
}

function inspectPremortemScanOutput(value: string): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate.length === 0) return { diagnostic: "premortem_scan_empty" };
  if (candidate.length > 4_000) return { diagnostic: "premortem_scan_too_large" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: candidate };
}

export function validatePremortemScanOutput(value: string): string | undefined {
  return inspectPremortemScanOutput(value).accepted;
}

function withoutMatchingQuotes(value: string): string {
  const pairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ]);
  const closing = pairs.get(value[0] ?? "");
  return closing && value.endsWith(closing) ? value.slice(1, -1) : value;
}

function withoutTerminalPunctuation(value: string): string {
  return value.replace(/[.!…]+$/u, "").trim();
}

function inspectPremortemTraceOutput(
  value: string,
  planExcerpt: string,
  failureConditionQuote: string,
  assumedFailure: string,
): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate === "NO GROUNDED TRACE") return { accepted: candidate };
  if (candidate.length === 0) return { diagnostic: "trace_empty" };
  if (candidate.length > 800 || candidate.includes("\n") || candidate.includes("?")) {
    return { diagnostic: "trace_bounds_or_layout" };
  }
  if (!candidate.startsWith("trace: ")) return { diagnostic: "trace_prefix_mismatch" };
  const trace = candidate.slice("trace: ".length);
  if ((trace.match(/->/g)?.length ?? 0) !== 2) return { diagnostic: "trace_transition_shape" };
  const segments = trace.split("->").map((part) => part.trim());
  if (segments.length !== 3 || segments.some((part) => !part || /^\[.*\]$/.test(part))) {
    return { diagnostic: "trace_transition_shape" };
  }
  const condition = withoutTerminalPunctuation(withoutMatchingQuotes(segments[0]!));
  const expectedCondition = withoutTerminalPunctuation(withoutMatchingQuotes(failureConditionQuote));
  const actualFailure = withoutTerminalPunctuation(withoutMatchingQuotes(segments[2]!));
  const expectedFailure = withoutTerminalPunctuation(withoutMatchingQuotes(assumedFailure));
  if (!condition || !planExcerpt.includes(failureConditionQuote) || condition !== expectedCondition) {
    return { diagnostic: "trace_condition_mismatch" };
  }
  if (actualFailure !== expectedFailure) return { diagnostic: "trace_failure_mismatch" };
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: `trace: ${segments[0]} -> ${segments[1]} -> ${segments[2]}` };
}

export function validatePremortemTraceOutput(
  value: string,
  planExcerpt: string,
  failureConditionQuote: string,
  assumedFailure: string,
): string | undefined {
  return inspectPremortemTraceOutput(value, planExcerpt, failureConditionQuote, assumedFailure).accepted;
}

function inspectAbusePathOutput(
  value: string,
  accessQuote: string,
  controlQuote: string,
  protectedOutcomeQuote: string,
): OutputInspection {
  const candidate = normalizeCandidate(value);
  if (candidate === "NO GROUNDED PATH") return { accepted: candidate };
  if (candidate.length === 0) return { diagnostic: "path_empty" };
  if (candidate.length > 1_000 || candidate.includes("\n") || candidate.includes("?")) {
    return { diagnostic: "path_bounds_or_layout" };
  }
  const canonical = candidate.startsWith("path: ");
  const path = canonical
    ? candidate.slice("path: ".length)
    : candidate.includes(":")
      ? ""
      : candidate;
  if (!path) return { diagnostic: "path_prefix_mismatch" };
  if ((path.match(/->/g)?.length ?? 0) !== 2) return { diagnostic: "path_transition_shape" };
  const segments = path.split("->").map((part) => part.trim());
  if (segments.length !== 3 || segments.some((part) => !part || /^\[.*\]$/.test(part))) {
    return { diagnostic: "path_transition_shape" };
  }
  if (!canonical && !segments[0]!.startsWith(accessQuote)) return { diagnostic: "path_access_mismatch" };
  const anchors = [accessQuote, controlQuote, protectedOutcomeQuote];
  if (segments.some((segment, index) => segment.split(anchors[index]!).length !== 2)) {
    return { diagnostic: "path_anchor_mismatch" };
  }
  if (segments[1] === controlQuote || segments[2] === protectedOutcomeQuote) {
    return { diagnostic: "path_missing_transition" };
  }
  if (findSecretLikeValue(candidate)) return { diagnostic: "secret_like_output" };
  return { accepted: `path: ${segments.join(" -> ")}` };
}

export function validateAbusePathOutput(
  value: string,
  accessQuote: string,
  controlQuote: string,
  protectedOutcomeQuote: string,
): string | undefined {
  return inspectAbusePathOutput(value, accessQuote, controlQuote, protectedOutcomeQuote).accepted;
}

export async function executeAdversarial(
  tool: SparringToolName,
  input: SparringInput,
  identity: ReviewIdentity,
  env: Env,
): Promise<SparringServiceResult> {
  if (findSecretLikeValue(input)) return { kind: "error", code: "secret_detected", providerLatencyMs: 0 };
  const rateKey = await reviewRateKey(env.IDENTITY_HMAC_KEY, identity.github_user_id);
  const rate = await env.RATE_LIMITER.limit({ key: rateKey });
  if (!rate.success) return { kind: "rate_limited" };

  const affinity = await sessionAffinity(env.IDENTITY_HMAC_KEY, identity.github_user_id);
  const model = await invokeSparringModel(env, tool, input, affinity);
  if (model.kind === "failure") {
    return { kind: "error", code: model.status, diagnosticCode: `provider_${model.category}`, providerLatencyMs: model.latencyMs };
  }

  const inspection: OutputInspection = tool === "stress_structure"
    ? inspectStressStructureOutput(model.content, (input as StressStructureInput).artifact_excerpt)
    : tool === "adversarial_review"
      ? inspectAdversarialReviewOutput(model.content)
    : tool === "sparring_pressure"
      ? inspectSparringPressureOutput(model.content)
      : tool === "sparring_scan"
        ? inspectSparringScanOutput(model.content, (input as SparringScanInput).idea)
      : tool === "redteam_experiment"
        ? inspectRedteamExperimentOutput(model.content)
      : tool === "premortem_scan"
        ? inspectPremortemScanOutput(model.content)
      : tool === "premortem_trace"
          ? inspectPremortemTraceOutput(
                model.content,
                (input as PremortemTraceInput).plan_excerpt,
                (input as PremortemTraceInput).failure_condition_quote,
                (input as PremortemTraceInput).assumed_failure,
              )
          : inspectAbusePathOutput(
                model.content,
                (input as AbusePathInput).access_quote,
                (input as AbusePathInput).control_quote,
                (input as AbusePathInput).protected_outcome_quote,
              );
  const accepted = inspection.accepted;
  if (!accepted) {
    return {
      kind: "error",
      code: "invalid_model_output",
      diagnosticCode: inspection.diagnostic ?? "postflight_invariant_failure",
      providerLatencyMs: model.latencyMs,
      ...(model.usage ? { usage: model.usage } : {}),
    };
  }
  return {
    kind: "success",
    text: accepted,
    providerLatencyMs: model.latencyMs,
    ...(model.usage ? { usage: model.usage } : {}),
  };
}

export const executeSparring = executeAdversarial;

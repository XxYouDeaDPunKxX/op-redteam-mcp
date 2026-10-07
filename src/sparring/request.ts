import abusePathPrompt from "../prompts/abuse-path-system-prompt.md";
import adversarialReviewPrompt from "../prompts/adversarial-review-system-prompt.md";
import freeformPremortemPrompt from "../prompts/freeform-premortem-system-prompt.md";
import premortemTracePrompt from "../prompts/premortem-trace-system-prompt.md";
import redteamExperimentPrompt from "../prompts/redteam-experiment-system-prompt.md";
import sparringScanPrompt from "../prompts/sparring-scan-system-prompt.md";
import sparringPressurePrompt from "../prompts/sparring-pressure-system-prompt.md";
import stressStructurePrompt from "../prompts/stress-structure-system-prompt.md";

export const GPT_OSS_ROLLBACK_MODEL = "@cf/openai/gpt-oss-120b";
export const NVIDIA_STRESS_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_PRESSURE_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const NVIDIA_SCAN_MODEL = NVIDIA_PRESSURE_MODEL;
export const NVIDIA_REDTEAM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_REVIEW_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const OPENROUTER_ABUSE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const OPENROUTER_PREMORTEM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const OPENROUTER_PREMORTEM_SCAN_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const MODEL_OUTPUT_CEILING = 4_096;
export const DISCOVERY_OUTPUT_CEILING = 8_192;
export const REDTEAM_OUTPUT_CEILING = DISCOVERY_OUTPUT_CEILING;

export type SparringToolName =
  | "stress_structure"
  | "adversarial_review"
  | "sparring_pressure"
  | "sparring_scan"
  | "premortem_trace"
  | "premortem_scan"
  | "abuse_path"
  | "redteam_experiment";
export type StressAttackLens = "contradiction" | "dependency" | "boundary" | "failure_path";
export type SparringChallengeLens = "assumption" | "failure_path" | "consequence" | "tradeoff";

export interface StressStructureInput {
  artifact_excerpt: string;
  target_quote: string;
  outcome_quote: string;
  attack_lens: StressAttackLens;
  claim_under_test: string;
}

export interface SparringPressureInput {
  idea_excerpt: string;
  target_quote: string;
  intended_outcome: string;
  challenge_lens: SparringChallengeLens;
}

export interface SparringScanInput {
  idea: string;
  intended_outcome: string;
}

export interface PremortemTraceInput {
  plan_excerpt: string;
  target_quote: string;
  outcome_quote: string;
  failure_condition_quote: string;
  assumed_failure: string;
}

export interface AbusePathInput {
  artifact_excerpt: string;
  access_quote: string;
  control_quote: string;
  protected_outcome_quote: string;
}

export interface RedteamExperimentInput {
  target: string;
  red_team_request: string;
  allowed_actions: string;
}

export interface AdversarialReviewInput {
  artifact: string;
  review_request: string;
}

export interface PremortemScanInput {
  plan: string;
  premortem_question: string;
}

export type SparringInput =
  | StressStructureInput
  | AdversarialReviewInput
  | SparringPressureInput
  | SparringScanInput
  | PremortemTraceInput
  | PremortemScanInput
  | AbusePathInput
  | RedteamExperimentInput;

export function systemPrompt(tool: SparringToolName): string {
  if (tool === "stress_structure") return stressStructurePrompt;
  if (tool === "adversarial_review") return adversarialReviewPrompt;
  if (tool === "sparring_pressure") return sparringPressurePrompt;
  if (tool === "sparring_scan") return sparringScanPrompt;
  if (tool === "premortem_trace") return premortemTracePrompt;
  if (tool === "premortem_scan") return freeformPremortemPrompt;
  if (tool === "redteam_experiment") return redteamExperimentPrompt;
  return abusePathPrompt;
}

export function modelMaterial(tool: SparringToolName, input: SparringInput): string {
  if (tool === "stress_structure") {
    const stress = input as StressStructureInput;
    return JSON.stringify({
      TARGET: stress.target_quote,
      EXPLICIT_OUTCOME: stress.outcome_quote,
      ATTACK_LENS: stress.attack_lens,
      CLAIM_UNDER_TEST: stress.claim_under_test,
      ORIGINAL_ARTIFACT: stress.artifact_excerpt,
    });
  }
  if (tool === "adversarial_review") {
    const review = input as AdversarialReviewInput;
    return JSON.stringify({
      REVIEW_REQUEST: review.review_request,
      ORIGINAL_ARTIFACT: review.artifact,
    });
  }
  if (tool === "sparring_pressure") {
    const pressure = input as SparringPressureInput;
    return JSON.stringify({
      TARGET: pressure.target_quote,
      INTENDED_OUTCOME: pressure.intended_outcome,
      CHALLENGE_LENS: pressure.challenge_lens,
      ORIGINAL_ARTIFACT: pressure.idea_excerpt,
    });
  }
  if (tool === "sparring_scan") {
    const scan = input as SparringScanInput;
    return JSON.stringify({
      INTENDED_OUTCOME: scan.intended_outcome,
      ORIGINAL_IDEA: scan.idea,
    });
  }
  if (tool === "premortem_trace") {
    const premortem = input as PremortemTraceInput;
    return JSON.stringify({
      TARGET: premortem.target_quote,
      EXPECTED_OUTCOME: premortem.outcome_quote,
      FAILURE_CONDITION: premortem.failure_condition_quote,
      ASSUMED_FAILURE: premortem.assumed_failure,
      PLAN_EXCERPT: premortem.plan_excerpt,
    });
  }
  if (tool === "premortem_scan") {
    const premortem = input as PremortemScanInput;
    return JSON.stringify({
      PREMORTEM_QUESTION: premortem.premortem_question,
      PLAN: premortem.plan,
    });
  }
  if (tool === "redteam_experiment") {
    const experiment = input as RedteamExperimentInput;
    return JSON.stringify({
      TARGET: experiment.target,
      RED_TEAM_REQUEST: experiment.red_team_request,
      ALLOWED_ACTIONS: experiment.allowed_actions,
    });
  }
  const abuse = input as AbusePathInput;
  return JSON.stringify({
    ACCESS_QUOTE: abuse.access_quote,
    CONTROL_QUOTE: abuse.control_quote,
    PROTECTED_OUTCOME_QUOTE: abuse.protected_outcome_quote,
    ARTIFACT_EXCERPT: abuse.artifact_excerpt,
  });
}

export function buildCloudflareRollbackRequest(tool: SparringToolName, input: SparringInput): Record<string, unknown> {
  return {
    instructions: systemPrompt(tool),
    input: modelMaterial(tool, input),
    reasoning: { effort: "high" },
    max_output_tokens:
      tool === "redteam_experiment" || tool === "adversarial_review" || tool === "premortem_scan" || tool === "sparring_scan"
        ? DISCOVERY_OUTPUT_CEILING
        : MODEL_OUTPUT_CEILING,
    store: false,
  };
}

export const buildSparringRequest = buildCloudflareRollbackRequest;

export function buildNvidiaRequest(
  tool: SparringToolName,
  input: SparringInput,
): Record<string, unknown> {
  const stress = tool === "stress_structure";
  const experiment = tool === "redteam_experiment";
  const review = tool === "adversarial_review";
  const scan = tool === "sparring_scan";
  const common = {
    model: stress ? NVIDIA_STRESS_MODEL : experiment ? NVIDIA_REDTEAM_MODEL : review ? NVIDIA_REVIEW_MODEL : scan ? NVIDIA_SCAN_MODEL : NVIDIA_PRESSURE_MODEL,
    messages: [
      { role: "system", content: systemPrompt(tool) },
      { role: "user", content: modelMaterial(tool, input) },
    ],
    temperature: scan ? 0.7 : 1,
    max_tokens: experiment || review || scan ? DISCOVERY_OUTPUT_CEILING : MODEL_OUTPUT_CEILING,
    stream: false,
  };
  if (stress) {
    return {
      ...common,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true },
    };
  }
  if (experiment || review) {
    return {
      ...common,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true },
    };
  }
  if (scan) {
    return {
      ...common,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true },
    };
  }
  return {
    ...common,
    top_p: 0.95,
    chat_template_kwargs: { enable_thinking: true, low_effort: true },
  };
}

export function buildOpenRouterRequest(input: AbusePathInput): Record<string, unknown> {
  return {
    model: OPENROUTER_ABUSE_MODEL,
    messages: [
      { role: "system", content: systemPrompt("abuse_path") },
      { role: "user", content: modelMaterial("abuse_path", input) },
    ],
    temperature: 0,
    max_tokens: MODEL_OUTPUT_CEILING,
    reasoning: { effort: "high", exclude: true },
    stream: false,
  };
}

export function buildOpenRouterPremortemRequest(input: PremortemTraceInput): Record<string, unknown> {
  return {
    model: OPENROUTER_PREMORTEM_MODEL,
    messages: [
      { role: "system", content: systemPrompt("premortem_trace") },
      { role: "user", content: modelMaterial("premortem_trace", input) },
    ],
    temperature: 0,
    max_tokens: MODEL_OUTPUT_CEILING,
    reasoning: { effort: "high", exclude: true },
    stream: false,
  };
}

export function buildOpenRouterPremortemScanRequest(input: PremortemScanInput): Record<string, unknown> {
  return {
    model: OPENROUTER_PREMORTEM_SCAN_MODEL,
    messages: [
      { role: "system", content: systemPrompt("premortem_scan") },
      { role: "user", content: modelMaterial("premortem_scan", input) },
    ],
    temperature: 0,
    max_tokens: DISCOVERY_OUTPUT_CEILING,
    reasoning: { effort: "high", exclude: true },
    stream: false,
  };
}

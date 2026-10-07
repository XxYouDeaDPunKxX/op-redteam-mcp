import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";

import type { ReviewIdentity } from "./contracts/types";
import type { Env } from "./env";
import { createLogSink, LOG_SOURCE, type StandardLogEvent } from "./log-sink";
import type { SparringInput, SparringToolName } from "./sparring/request";
import { executeAdversarial } from "./sparring/service";
import { subjectHash } from "./security/identity";
import { emitSparringTelemetry } from "./telemetry";

const securitySchemes = [{ type: "oauth2", scopes: ["review:invoke"] }] as const;
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const RUNTIME_VERSION = "3.9.3";
export const SERVER_INSTRUCTIONS =
  "The calling model selects one matching tool, prepares one bounded self-contained packet, and makes one call. Use stress_structure when one relation is isolated and adversarial_review when structural discovery is requested without one isolated relation. Use sparring_pressure when the calling model has isolated the target and lens; use sparring_scan when only one early idea and its exact intended outcome are known. Use premortem_trace when one exact failure condition is supplied and premortem_scan when only the failed outcome is known. Treat each provider output as a candidate, not evidence or a decision. Triage each complete tool-defined unit as usable, usable_with_limits, or unusable; do not split it to salvage a component. Use usable units directly. For usable_with_limits, preserve the grounded unit, develop at most two grounded readings, and state its limit. For unusable, reject the unit; only if no usable or usable_with_limits unit remains, keep at most one non-assertive packet-grounded residual, otherwise one diagnostic. Never return both a preserved signal and a residual. Do not assert the missing condition, retain an invented actor, system, or capability, reconnect discarded steps, or repair a causal chain. Hypotheses are allowed where the selected tool defines them but are not evidence. Test data may be created only where allowed_actions permits it. Never add facts, propose fixes automatically, make a decision, call multiple tools, or retry automatically.";

const stressInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifact_excerpt", "target_quote", "outcome_quote", "attack_lens", "claim_under_test"],
  properties: {
    artifact_excerpt: { type: "string", minLength: 1, maxLength: 16_000, description: "Verbatim self-contained excerpt containing both exact quotes." },
    target_quote: { type: "string", minLength: 1, maxLength: 2_000, description: "Exact substring identifying the mechanism to stress." },
    outcome_quote: { type: "string", minLength: 1, maxLength: 2_000, description: "Exact substring identifying the explicitly stated outcome." },
    attack_lens: {
      type: "string",
      enum: ["contradiction", "dependency", "boundary", "failure_path"],
      description: "Single adversarial lens selected by the calling model before invoking the tool.",
    },
    claim_under_test: {
      type: "string",
      minLength: 2,
      maxLength: 500,
      description: "One declarative relation between target_quote and outcome_quote, using the source's own certainty.",
    },
  },
} as const;

const adversarialReviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifact", "review_request"],
  properties: {
    artifact: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained artifact to review. Include the material the model may treat as factual authority; do not add hidden context.",
    },
    review_request: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description: "One natural-language adversarial question or bounded review focus prepared from the user's request; add no target facts, requirements, or desired answer.",
    },
  },
} as const;

const pressureInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["idea_excerpt", "target_quote", "intended_outcome", "challenge_lens"],
  properties: {
    idea_excerpt: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained excerpt containing target_quote and enough context to understand intended_outcome.",
    },
    target_quote: { type: "string", minLength: 1, maxLength: 2_000, description: "Exact substring identifying the assumption or mechanism to challenge." },
    intended_outcome: { type: "string", minLength: 1, maxLength: 500, description: "One-line synthesis of the user's stated objective; do not turn it into a new requirement." },
    challenge_lens: {
      type: "string",
      enum: ["assumption", "failure_path", "consequence", "tradeoff"],
      description: "Single adversarial lens selected by the calling model before invoking the tool.",
    },
  },
} as const;

const sparringScanInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["idea", "intended_outcome"],
  properties: {
    idea: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained early idea containing the exact intended_outcome. Add no target, lens, aspect, variation, cause, or desired answer.",
    },
    intended_outcome: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Exact one-line declarative substring naming the idea's stated outcome.",
    },
  },
} as const;

const premortemInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan_excerpt", "target_quote", "outcome_quote", "failure_condition_quote", "assumed_failure"],
  properties: {
    plan_excerpt: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained plan excerpt containing target_quote, outcome_quote, and failure_condition_quote.",
    },
    target_quote: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "Exact substring identifying the plan mechanism through which failure could propagate.",
    },
    outcome_quote: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "Exact substring identifying the explicitly expected outcome.",
    },
    failure_condition_quote: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "Exact substring identifying one stated condition that could propagate through target_quote into assumed_failure. If none exists, do not call this tool.",
    },
    assumed_failure: {
      type: "string",
      minLength: 2,
      maxLength: 500,
      description: "One-line counterfactual failure of outcome_quote prepared by the calling model; no added actor, system, feature, requirement, or second outcome.",
    },
  },
} as const;

const premortemScanInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "premortem_question"],
  properties: {
    plan: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained factual plan. The calling model does not add an initiating cause, actor, system, or mitigation.",
    },
    premortem_question: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description: "Natural-language premortem question naming one exact outcome to assume failed; add no plan facts or proposed causes.",
    },
  },
} as const;

const abuseInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifact_excerpt", "access_quote", "control_quote", "protected_outcome_quote"],
  properties: {
    artifact_excerpt: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained excerpt containing access_quote, control_quote, and protected_outcome_quote.",
    },
    access_quote: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Exact one-line substring stating one access, permission, action, interface, or capability whose path to control_quote needs no unstated capability or compressed action chain.",
    },
    control_quote: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Exact one-line substring stating the single control or boundary the path would defeat. If none exists, do not call this tool.",
    },
    protected_outcome_quote: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Exact one-line substring stating the result protected by control_quote; do not synthesize a new requirement or impact.",
    },
  },
} as const;

const redteamExperimentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target", "red_team_request", "allowed_actions"],
  properties: {
    target: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Self-contained target facts and stated outcome needed to design one experiment.",
    },
    red_team_request: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "One bounded, authorized experiment objective prepared by the calling model from the user's request.",
    },
    allowed_actions: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "Complete set of methods and observations authorized for this experiment; add no unstated capability.",
    },
  },
} as const;

const stressOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "Flat connector-compatible projection. status determines candidate-field presence; the runtime never emits grounded_break without both what_breaks and evidence. The calling model must triage logical grounding and usefulness before use.",
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["grounded_break", "no_grounded_break"],
      description: "Whether deterministic shape and verbatim-evidence validation returned one break candidate or the no-break sentinel; not a semantic usability judgment.",
    },
    what_breaks: {
      type: "string",
      description: "Present only for grounded_break. One candidate logical challenge to the supplied relation.",
    },
    evidence: {
      type: "string",
      description: "Present only for grounded_break. Verbatim evidence validated against artifact_excerpt.",
    },
  },
} as const;

const adversarialReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "One bounded provider candidate. The calling model must triage grounding, structural relevance, fix fit, goal preservation, and usefulness before use; formatting is not semantic validation.",
  required: ["review"],
  properties: {
    review: {
      type: "string",
      maxLength: 12_000,
      description: "Human-readable review candidate. Runtime validation proves only non-empty bounded text and secret screening, not semantic correctness.",
    },
  },
} as const;

const pressureOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "One validated-shape hypothetical mechanism candidate. The calling model must triage grounding, directness, and usefulness before use.",
  required: ["property", "variation", "effect"],
  properties: {
    property: {
      type: "string",
      maxLength: 200,
      description: "Compatibility field containing the first mechanism slot.",
    },
    variation: {
      type: "string",
      maxLength: 200,
      description: "The hypothetical change applied to that factor.",
    },
    effect: {
      type: "string",
      maxLength: 300,
      description: "The candidate direct effect on intended_outcome.",
    },
  },
} as const;

const sparringScanOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "One bounded provider candidate. Deterministic validation proves only sentinel or four-field shape, exact source spans, bounds, secret screening, and arrow depth. The calling model must classify a non-sentinel result as usable, usable_with_limits, or unusable before use; formatting is not semantic validation.",
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["pressure", "no_grounded_pressure"],
      description: "Whether deterministic validation returned one pressure candidate or the no-pressure sentinel; not a semantic usability judgment.",
    },
    mechanism: {
      type: "string",
      maxLength: 500,
      description: "Present only for pressure. Exact source span selected as the load-bearing mechanism candidate.",
    },
    aspect: {
      type: "string",
      maxLength: 300,
      description: "Present only for pressure. Exact source span selected as one operational aspect candidate.",
    },
    variation: {
      type: "string",
      maxLength: 300,
      description: "Present only for pressure. One hypothetical variation candidate for aspect.",
    },
    pressure: {
      type: "string",
      maxLength: 600,
      description: "Present only for pressure. One direct candidate pressure or one intermediate followed by pressure on intended_outcome.",
    },
  },
} as const;

const premortemOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "Flat connector-compatible projection. status determines trace presence; the runtime never emits trace status without trace content. The calling model must triage causal grounding and usefulness before use.",
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["trace", "no_grounded_trace"],
      description: "Whether deterministic validation returned one trace candidate or the no-trace sentinel; not a final causal or usability judgment.",
    },
    trace: {
      type: "string",
      maxLength: 800,
      description: "Present only for trace status. One candidate path from the supplied condition through the target to the assumed failure. Treat it as a hypothesis.",
    },
  },
} as const;

const premortemScanOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "One bounded premortem candidate. The calling model must triage hypothesis scope, transition grounding, endpoint fidelity, and usefulness before use; formatting is not semantic validation.",
  required: ["premortem"],
  properties: {
    premortem: {
      type: "string",
      maxLength: 4_000,
      description: "Human-readable hypothesis and causal-path candidate. Runtime validation proves only non-empty bounded text and secret screening.",
    },
  },
} as const;

const abuseOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "Flat connector-compatible projection. status determines path presence; the runtime never emits abuse_path status without path content. The calling model must triage feasibility, grounding, and usefulness before use.",
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["abuse_path", "no_grounded_path"],
      description: "Whether deterministic anchor validation returned one path candidate or the no-path sentinel; not a final feasibility or usability judgment.",
    },
    path: {
      type: "string",
      maxLength: 1_000,
      description: "Present only for abuse_path status. One candidate path from the supplied access through the supplied control to the protected outcome. Intentional use is hypothetical.",
    },
  },
} as const;

const redteamExperimentOutputSchema = {
  type: "object",
  additionalProperties: false,
  description: "One bounded experiment candidate. The calling model must triage authorization-boundary compliance, falsifiability, observability, and usefulness before use; formatting is not semantic validation.",
  required: ["experiment"],
  properties: {
    experiment: {
      type: "string",
      maxLength: 6_000,
      description: "Human-readable experiment candidate. Runtime validation proves only non-empty bounded text and secret screening; the tool never executes it.",
    },
  },
} as const;

const toolDescriptors = [
  {
    name: "stress_structure",
    title: "Stress Structure",
    description:
      "Test one explicit target-to-outcome claim. Returns one evidence-anchored challenge or NO GROUNDED BREAK. The calling model triages the candidate; no fixes or decisions.",
    inputSchema: stressInputSchema,
    outputSchema: stressOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "sparring_pressure",
    title: "Sparring Pressure",
    description:
      "Pressure one early idea with one hypothetical mechanism and direct effect. The calling model supplies one target, outcome, and lens, then triages the candidate. No findings, fixes, or decisions.",
    inputSchema: pressureInputSchema,
    outputSchema: pressureOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "premortem_trace",
    title: "Premortem Trace",
    description:
      "Trace one stated failure condition through one plan target to one assumed failure. Returns one causal hypothesis or NO GROUNDED TRACE. The calling model triages it; no cause list, fixes, or decisions.",
    inputSchema: premortemInputSchema,
    outputSchema: premortemOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "abuse_path",
    title: "Abuse Path",
    description:
      "Trace one supplied access through one control to one protected outcome. Returns one hypothetical abuse path or NO GROUNDED PATH. The calling model triages it; no threat list, fixes, or decisions.",
    inputSchema: abuseInputSchema,
    outputSchema: abuseOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "redteam_experiment",
    title: "Red-Team Experiment",
    description:
      "Design one authorized, falsifiable experiment against a supplied target. The calling model provides the complete action and observation boundary, then triages the candidate. No execution, fixes, or decisions.",
    inputSchema: redteamExperimentInputSchema,
    outputSchema: redteamExperimentOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "adversarial_review",
    title: "Adversarial Review",
    description:
      "Use when structural review is requested but the calling model has not isolated one relation. The model behind the tool selects candidate breaks and smallest fixes from one artifact. The calling model triages each; no style review, scoring, or decisions.",
    inputSchema: adversarialReviewInputSchema,
    outputSchema: adversarialReviewOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "premortem_scan",
    title: "Premortem Scan",
    description:
      "Use when one failed outcome is known but no initiating condition is isolated. The model behind the tool proposes one hypothesis and causal path from one plan. The calling model triages it; no cause list, fixes, scoring, or decisions.",
    inputSchema: premortemScanInputSchema,
    outputSchema: premortemScanOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "sparring_scan",
    title: "Sparring Scan",
    description:
      "Openly select and pressure one load-bearing mechanism in an early idea when the calling model has only the idea and exact intended outcome. Returns one mechanism-preserving pressure candidate or no grounded pressure. The calling model triages grounding, preservation, causal support, and usefulness; no findings, fixes, retries, or decisions.",
    inputSchema: sparringScanInputSchema,
    outputSchema: sparringScanOutputSchema,
    annotations,
    securitySchemes,
    _meta: { securitySchemes },
  },
] as const;

function readIdentity(env: Env): ReviewIdentity {
  if (env.AUTH_MODE === "none") return { github_user_id: 0, login: "local" };
  const props = getMcpAuthContext()?.props;
  const githubUserId = props?.github_user_id;
  const login = props?.login;
  if (!Number.isSafeInteger(githubUserId) || (githubUserId as number) <= 0 || typeof login !== "string" || login.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, "Invalid authentication context");
  }
  return { github_user_id: githubUserId as number, login };
}

function readRecord(argumentsValue: unknown): Record<string, unknown> {
  if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new McpError(ErrorCode.InvalidParams, "Tool arguments must be an object");
  }
  return argumentsValue as Record<string, unknown>;
}

function readText(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a bounded non-empty string without outer whitespace`);
  }
  return value;
}

function readToolInput(tool: SparringToolName, argumentsValue: unknown): SparringInput {
  const record = readRecord(argumentsValue);
  if (tool === "stress_structure") {
    const expected = ["artifact_excerpt", "target_quote", "outcome_quote", "attack_lens", "claim_under_test"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Exactly artifact_excerpt, target_quote, outcome_quote, attack_lens, and claim_under_test are required",
      );
    }
    const artifactExcerpt = readText(record, "artifact_excerpt", 16_000);
    const targetQuote = readText(record, "target_quote", 2_000);
    const outcomeQuote = readText(record, "outcome_quote", 2_000);
    const attackLens = readText(record, "attack_lens", 32);
    if (!(["contradiction", "dependency", "boundary", "failure_path"] as const).includes(attackLens as never)) {
      throw new McpError(ErrorCode.InvalidParams, "attack_lens is not supported");
    }
    const claimUnderTest = readText(record, "claim_under_test", 500);
    if (claimUnderTest.includes("\n") || claimUnderTest.includes("\r") || claimUnderTest.endsWith("?")) {
      throw new McpError(ErrorCode.InvalidParams, "claim_under_test must be one declarative line, not a question");
    }
    if (!artifactExcerpt.includes(targetQuote) || !artifactExcerpt.includes(outcomeQuote)) {
      throw new McpError(ErrorCode.InvalidParams, "target_quote and outcome_quote must be exact substrings of artifact_excerpt");
    }
    return {
      artifact_excerpt: artifactExcerpt,
      target_quote: targetQuote,
      outcome_quote: outcomeQuote,
      attack_lens: attackLens as "contradiction" | "dependency" | "boundary" | "failure_path",
      claim_under_test: claimUnderTest,
    };
  }
  if (tool === "adversarial_review") {
    const expected = ["artifact", "review_request"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly artifact and review_request are required");
    }
    return {
      artifact: readText(record, "artifact", 16_000),
      review_request: readText(record, "review_request", 1_000),
    };
  }
  if (tool === "premortem_trace") {
    const expected = ["plan_excerpt", "target_quote", "outcome_quote", "failure_condition_quote", "assumed_failure"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly plan_excerpt, target_quote, outcome_quote, failure_condition_quote, and assumed_failure are required");
    }
    const planExcerpt = readText(record, "plan_excerpt", 16_000);
    const targetQuote = readText(record, "target_quote", 2_000);
    const outcomeQuote = readText(record, "outcome_quote", 2_000);
    const failureConditionQuote = readText(record, "failure_condition_quote", 2_000);
    const assumedFailure = readText(record, "assumed_failure", 500);
    if (assumedFailure.includes("\n") || assumedFailure.includes("\r") || assumedFailure.endsWith("?")) {
      throw new McpError(ErrorCode.InvalidParams, "assumed_failure must be one declarative line, not a question");
    }
    if (!planExcerpt.includes(targetQuote) || !planExcerpt.includes(outcomeQuote) || !planExcerpt.includes(failureConditionQuote)) {
      throw new McpError(ErrorCode.InvalidParams, "target_quote, outcome_quote, and failure_condition_quote must be exact substrings of plan_excerpt");
    }
    return {
      plan_excerpt: planExcerpt,
      target_quote: targetQuote,
      outcome_quote: outcomeQuote,
      failure_condition_quote: failureConditionQuote,
      assumed_failure: assumedFailure,
    };
  }
  if (tool === "premortem_scan") {
    const expected = ["plan", "premortem_question"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly plan and premortem_question are required");
    }
    return {
      plan: readText(record, "plan", 16_000),
      premortem_question: readText(record, "premortem_question", 1_000),
    };
  }
  if (tool === "abuse_path") {
    const expected = ["artifact_excerpt", "access_quote", "control_quote", "protected_outcome_quote"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly artifact_excerpt, access_quote, control_quote, and protected_outcome_quote are required");
    }
    const artifactExcerpt = readText(record, "artifact_excerpt", 16_000);
    const accessQuote = readText(record, "access_quote", 500);
    const controlQuote = readText(record, "control_quote", 500);
    const protectedOutcomeQuote = readText(record, "protected_outcome_quote", 500);
    const quotes = [accessQuote, controlQuote, protectedOutcomeQuote];
    if (quotes.some((quote) => quote.includes("\n") || quote.includes("\r"))) {
      throw new McpError(ErrorCode.InvalidParams, "abuse_path quotes must each be one line");
    }
    if (new Set(quotes).size !== quotes.length) {
      throw new McpError(ErrorCode.InvalidParams, "access_quote, control_quote, and protected_outcome_quote must be distinct anchors");
    }
    if (quotes.some((quote) => !artifactExcerpt.includes(quote))) {
      throw new McpError(ErrorCode.InvalidParams, "all abuse_path quotes must be exact substrings of artifact_excerpt");
    }
    return {
      artifact_excerpt: artifactExcerpt,
      access_quote: accessQuote,
      control_quote: controlQuote,
      protected_outcome_quote: protectedOutcomeQuote,
    };
  }
  if (tool === "redteam_experiment") {
    const expected = ["target", "red_team_request", "allowed_actions"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly target, red_team_request, and allowed_actions are required");
    }
    return {
      target: readText(record, "target", 16_000),
      red_team_request: readText(record, "red_team_request", 2_000),
      allowed_actions: readText(record, "allowed_actions", 2_000),
    };
  }
  if (tool === "sparring_scan") {
    const expected = ["idea", "intended_outcome"];
    if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
      throw new McpError(ErrorCode.InvalidParams, "Exactly idea and intended_outcome are required");
    }
    const idea = readText(record, "idea", 16_000);
    const intendedOutcome = readText(record, "intended_outcome", 500);
    if (intendedOutcome.includes("\n") || intendedOutcome.includes("\r") || intendedOutcome.endsWith("?")) {
      throw new McpError(ErrorCode.InvalidParams, "intended_outcome must be one declarative line, not a question");
    }
    if (!idea.includes(intendedOutcome)) {
      throw new McpError(ErrorCode.InvalidParams, "intended_outcome must be an exact substring of idea");
    }
    return { idea, intended_outcome: intendedOutcome };
  }
  const expected = ["idea_excerpt", "target_quote", "intended_outcome", "challenge_lens"];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
    throw new McpError(ErrorCode.InvalidParams, "Exactly idea_excerpt, target_quote, intended_outcome, and challenge_lens are required");
  }
  const ideaExcerpt = readText(record, "idea_excerpt", 16_000);
  const targetQuote = readText(record, "target_quote", 2_000);
  const intendedOutcome = readText(record, "intended_outcome", 500);
  const challengeLens = readText(record, "challenge_lens", 32);
  if (intendedOutcome.includes("\n") || intendedOutcome.includes("\r")) {
    throw new McpError(ErrorCode.InvalidParams, "intended_outcome must be one line");
  }
  if (!( ["assumption", "failure_path", "consequence", "tradeoff"] as const).includes(challengeLens as never)) {
    throw new McpError(ErrorCode.InvalidParams, "challenge_lens is not supported");
  }
  if (!ideaExcerpt.includes(targetQuote)) {
    throw new McpError(ErrorCode.InvalidParams, "target_quote must be an exact substring of idea_excerpt");
  }
  return {
    idea_excerpt: ideaExcerpt,
    target_quote: targetQuote,
    intended_outcome: intendedOutcome,
    challenge_lens: challengeLens as "assumption" | "failure_path" | "consequence" | "tradeoff",
  };
}

function structuredToolOutput(tool: SparringToolName, text: string): Record<string, string> {
  if (tool === "adversarial_review") return { review: text };
  if (tool === "premortem_scan") return { premortem: text };
  if (tool === "redteam_experiment") return { experiment: text };
  if (tool === "sparring_scan") {
    if (text === "NO GROUNDED PRESSURE") return { status: "no_grounded_pressure" };
    const lines = text.split("\n");
    return {
      status: "pressure",
      mechanism: lines[0]!.slice("MECHANISM: ".length),
      aspect: lines[1]!.slice("ASPECT: ".length),
      variation: lines[2]!.slice("VARIATION: ".length),
      pressure: lines[3]!.slice("PRESSURE: ".length),
    };
  }
  if (tool === "sparring_pressure") {
    const [variationBlock, effect] = text.slice("mechanism: ".length).split("->").map((part) => part.trim());
    const [property, variation] = variationBlock!.split("::").map((part) => part.trim());
    return { property: property!, variation: variation!, effect: effect! };
  }
  if (tool === "abuse_path") {
    return text === "NO GROUNDED PATH"
      ? { status: "no_grounded_path" }
      : { status: "abuse_path", path: text.slice("path: ".length) };
  }
  if (tool === "premortem_trace") {
    return text === "NO GROUNDED TRACE"
      ? { status: "no_grounded_trace" }
      : { status: "trace", trace: text.slice("trace: ".length) };
  }
  if (text === "NO GROUNDED BREAK") return { status: "no_grounded_break" };
  const lines = text.split("\n");
  return {
    status: "grounded_break",
    what_breaks: lines[0]!.slice("what_breaks: ".length),
    evidence: lines[1]!.slice("evidence: ".length),
  };
}

const publicDiagnosticCategories = new Map([
  ["provider_quota", "provider_quota"],
  ["provider_capacity", "provider_capacity"],
  ["provider_provider_timeout", "provider_timeout"],
  ["provider_provider_abort", "provider_abort"],
  ["provider_deadline", "deadline"],
  ["provider_provider_configuration", "provider_configuration"],
  ["provider_invalid_provider_request", "invalid_provider_request"],
  ["provider_provider_unavailable", "provider_unavailable"],
  ["provider_invalid_envelope", "invalid_envelope"],
  ["provider_truncated_output", "truncated_output"],
  ["provider_unexpected_finish_reason", "unexpected_finish_reason"],
  ["provider_unexpected_tool_call", "unexpected_tool_call"],
  ["provider_model_refusal", "model_refusal"],
  ["provider_empty_output", "empty_output"],
  ["provider_provider_not_found", "provider_not_found"],
  ["provider_provider_rate_limited", "provider_rate_limited"],
  ["provider_provider_server_error", "provider_server_error"],
  ["provider_provider_bad_gateway", "provider_bad_gateway"],
  ["provider_provider_service_unavailable", "provider_service_unavailable"],
  ["provider_provider_gateway_timeout", "provider_gateway_timeout"],
  ["provider_provider_authentication", "provider_authentication"],
  ["provider_invalid_json", "invalid_json"],
  ["provider_invalid_response_object", "invalid_response_object"],
  ["provider_provider_error_envelope", "provider_error_envelope"],
  ["provider_missing_choices", "missing_choices"],
  ["provider_unexpected_choice_count", "unexpected_choice_count"],
  ["provider_invalid_choice", "invalid_choice"],
  ["provider_missing_message", "missing_message"],
  ["provider_unexpected_message_role", "unexpected_message_role"],
  ["provider_non_text_content", "non_text_content"],
  ["provider_unexpected_response_type", "unexpected_response_type"],
  ["provider_missing_output", "missing_output"],
  ["provider_invalid_output_item", "invalid_output_item"],
  ["provider_unexpected_message_count", "unexpected_message_count"],
  ["provider_invalid_message", "invalid_message"],
  ["provider_unexpected_content_count", "unexpected_content_count"],
  ["provider_invalid_content_part", "invalid_content_part"],
  ["stress_empty", "stress_empty"],
  ["stress_shape_mismatch", "stress_shape_mismatch"],
  ["stress_placeholder", "stress_placeholder"],
  ["stress_evidence_not_verbatim", "stress_evidence_not_verbatim"],
  ["review_empty", "review_empty"],
  ["review_too_large", "review_too_large"],
  ["pressure_empty", "pressure_empty"],
  ["pressure_not_single_line", "pressure_not_single_line"],
  ["pressure_prefix_mismatch", "pressure_prefix_mismatch"],
  ["pressure_arrow_count", "pressure_arrow_count"],
  ["pressure_separator_count", "pressure_separator_count"],
  ["pressure_empty_slot", "pressure_empty_slot"],
  ["scan_empty", "scan_empty"],
  ["scan_shape_mismatch", "scan_shape_mismatch"],
  ["scan_placeholder", "scan_placeholder"],
  ["scan_mechanism_not_verbatim", "scan_mechanism_not_verbatim"],
  ["scan_aspect_not_verbatim", "scan_aspect_not_verbatim"],
  ["scan_variation_invalid", "scan_variation_invalid"],
  ["scan_pressure_too_large", "scan_pressure_too_large"],
  ["scan_pressure_depth", "scan_pressure_depth"],
  ["scan_too_large", "scan_too_large"],
  ["experiment_empty", "experiment_empty"],
  ["experiment_too_large", "experiment_too_large"],
  ["premortem_scan_empty", "premortem_scan_empty"],
  ["premortem_scan_too_large", "premortem_scan_too_large"],
  ["trace_empty", "trace_empty"],
  ["trace_bounds_or_layout", "trace_bounds_or_layout"],
  ["trace_prefix_mismatch", "trace_prefix_mismatch"],
  ["trace_transition_shape", "trace_transition_shape"],
  ["trace_condition_mismatch", "trace_condition_mismatch"],
  ["trace_failure_mismatch", "trace_failure_mismatch"],
  ["path_empty", "path_empty"],
  ["path_bounds_or_layout", "path_bounds_or_layout"],
  ["path_prefix_mismatch", "path_prefix_mismatch"],
  ["path_transition_shape", "path_transition_shape"],
  ["path_access_mismatch", "path_access_mismatch"],
  ["path_anchor_mismatch", "path_anchor_mismatch"],
  ["path_missing_transition", "path_missing_transition"],
  ["secret_like_output", "secret_like_output"],
  ["postflight_invariant_failure", "postflight_invariant_failure"],
]);

export function publicDiagnosticCategory(diagnosticCode: string | undefined): string | undefined {
  if (!diagnosticCode) return undefined;
  return publicDiagnosticCategories.get(diagnosticCode) ?? "unspecified";
}

export function publicToolError(code: string, diagnosticCode?: string): Record<string, string> {
  const diagnosticCategory = publicDiagnosticCategory(diagnosticCode);
  if (code === "secret_detected") {
    return { code, stage: "preflight", retry_policy: "not_retryable" };
  }
  if (code === "invalid_model_output") {
    return {
      code,
      stage: "postflight",
      ...(diagnosticCategory ? { diagnostic_category: diagnosticCategory } : {}),
      retry_policy: "operator_only",
    };
  }
  return {
    code,
    stage: "provider",
    ...(diagnosticCategory ? { diagnostic_category: diagnosticCategory } : {}),
    retry_policy: "operator_only",
  };
}

export function createServer(env: Env, ctx?: ExecutionContext): Server {
  const server = new Server(
    { name: "OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges", version: RUNTIME_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDescriptors as unknown as Array<Record<string, unknown>>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      request.params.name !== "stress_structure" &&
      request.params.name !== "adversarial_review" &&
      request.params.name !== "sparring_pressure" &&
      request.params.name !== "premortem_trace" &&
      request.params.name !== "premortem_scan" &&
      request.params.name !== "abuse_path" &&
      request.params.name !== "redteam_experiment" &&
      request.params.name !== "sparring_scan"
    ) {
      throw new McpError(ErrorCode.MethodNotFound, "Unknown tool");
    }
    return runAdversarialTool(request.params.name as SparringToolName, request.params.arguments, readIdentity(env), env, ctx);
  });

  return server;
}

export async function runAdversarialTool(
  tool: SparringToolName,
  argumentsValue: unknown,
  identity: ReviewIdentity,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Record<string, unknown>> {
  const input = readToolInput(tool, argumentsValue);
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const result = await executeAdversarial(tool, input, identity, env);
  const scheduleEvent = async (response: Record<string, unknown>): Promise<void> => {
    if (!ctx || (result.kind === "error" && result.code === "secret_detected")) return;
    const event: StandardLogEvent = {
      schemaVersion: "1",
      eventId: requestId,
      occurredAt: new Date().toISOString(),
      source: LOG_SOURCE,
      subjectHash: await subjectHash(env.IDENTITY_HMAC_KEY, identity.github_user_id),
      tool,
      runtimeVersion: RUNTIME_VERSION,
      outcome: result.kind === "success" ? "ok" : result.kind === "rate_limited" ? "rate_limited" : result.code,
      providerLatencyMs: result.kind === "rate_limited" ? 0 : result.providerLatencyMs,
      totalLatencyMs: Math.max(0, Date.now() - started),
      ...(result.kind !== "rate_limited" && result.usage ? { usage: result.usage } : {}),
      request: input,
      response,
    };
    scheduleLogSink(env, ctx, event);
  };
  if (result.kind === "rate_limited") {
    const response = {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ code: "rate_limited", stage: "rate_limit", retry_policy: "operator_only" }) }],
    };
    await scheduleEvent(response);
    return response;
  }
  await emitSparringTelemetry(env, {
    requestId,
    githubUserId: identity.github_user_id,
    tool,
    outcome: result.kind === "success" ? "ok" : result.code,
    ...(result.kind === "error" && result.diagnosticCode ? { diagnostic: result.diagnosticCode } : {}),
    providerLatencyMs: result.providerLatencyMs,
    totalLatencyMs: Math.max(0, Date.now() - started),
    ...(result.usage ? { usage: result.usage } : {}),
  });
  if (result.kind === "error") {
    const publicError = publicToolError(result.code, result.diagnosticCode);
    const response = {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(publicError) }],
    };
    await scheduleEvent(response);
    return response;
  }
  const response = {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent: structuredToolOutput(tool, result.text),
  };
  await scheduleEvent(response);
  return response;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(createServer(env, ctx), {
      route: "/mcp",
      enableJsonResponse: true,
    })(request, env, ctx);
  },
};

function scheduleLogSink(env: Env, ctx: ExecutionContext, event: StandardLogEvent): void {
  ctx.waitUntil((async () => {
    const delivery = await createLogSink(env).emit(event);
    if (delivery.status === "failed") {
      env.ANALYTICS.writeDataPoint({ indexes: [event.eventId], blobs: ["log_sink_delivery_failed", event.tool] });
    }
  })());
}

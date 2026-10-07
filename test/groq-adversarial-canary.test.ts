// @ts-expect-error Vitest executes this certification-only file in Node; the Worker project intentionally omits Node types.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  modelMaterial,
  systemPrompt,
  type AbusePathInput,
  type PremortemTraceInput,
  type SparringPressureInput,
  type SparringInput,
  type SparringToolName,
  type StressStructureInput,
} from "../src/sparring/request";

declare const process: { env: Record<string, string | undefined>; cwd(): string };
import {
  validateAbusePathOutput,
  validateAdversarialReviewOutput,
  validatePremortemScanOutput,
  validatePremortemTraceOutput,
  validateRedteamExperimentOutput,
  validateSparringPressureOutput,
  validateStressStructureOutput,
} from "../src/sparring/service";
import { canaryResultPath } from "./canary-output";

const endpoint = "https://api.groq.com/openai/v1/chat/completions";
const runs = [
  { model: "openai/gpt-oss-120b", tool: "adversarial_review", reasoningEffort: "high", temperature: 0.6 },
  { model: "openai/gpt-oss-120b", tool: "redteam_experiment", reasoningEffort: "high", temperature: 0.6 },
  { model: "openai/gpt-oss-20b", tool: "stress_structure", reasoningEffort: "high", temperature: 0.6 },
  { model: "openai/gpt-oss-20b", tool: "sparring_pressure", reasoningEffort: "high", temperature: 0.6 },
  { model: "qwen/qwen3.6-27b", tool: "premortem_trace", reasoningEffort: "default", temperature: 1.0 },
  { model: "qwen/qwen3.6-27b", tool: "premortem_scan", reasoningEffort: "default", temperature: 1.0 },
  { model: "qwen/qwen3-32b", tool: "abuse_path", reasoningEffort: "default", temperature: 0.6 },
] as const satisfies ReadonlyArray<{
  model: string;
  tool: SparringToolName;
  reasoningEffort: "high" | "default";
  temperature: number;
}>;
type CanaryTool = (typeof runs)[number]["tool"];

const fixtures: Record<CanaryTool, SparringInput> = {
  stress_structure: {
    artifact_excerpt: "Il sistema usa il solo orario di inizio per evitare sovrapposizioni.",
    target_quote: "usa il solo orario di inizio",
    outcome_quote: "evitare sovrapposizioni",
    attack_lens: "boundary",
    claim_under_test: "Orari di inizio differenti sono sufficienti a evitare sovrapposizioni.",
  },
  sparring_pressure: {
    idea_excerpt: "Una biblioteca apre tutta la notte per aumentare l'accesso degli studenti.",
    target_quote: "apre tutta la notte",
    intended_outcome: "aumentare l'accesso degli studenti",
    challenge_lens: "consequence",
  },
  premortem_trace: {
    plan_excerpt: "Ogni ordine lascia il magazzino entro due ore. La linea completa un ordine prima di iniziare il successivo. Gli ordini grandi non hanno un tempo massimo.",
    target_quote: "La linea completa un ordine prima di iniziare il successivo.",
    outcome_quote: "Ogni ordine lascia il magazzino entro due ore.",
    failure_condition_quote: "Gli ordini grandi non hanno un tempo massimo.",
    assumed_failure: "Un ordine resta in attesa e non lascia il magazzino entro due ore.",
  },
  abuse_path: {
    artifact_excerpt: "Gli utenti autenticati possono condividere un link firmato. Il link firmato scade dopo dieci minuti. Il validatore accetta il link se è stato emesso prima della scadenza, senza controllare l'ora della richiesta. L'obiettivo è impedire accessi al report dopo la scadenza.",
    access_quote: "possono condividere un link firmato",
    control_quote: "Il link firmato scade dopo dieci minuti",
    protected_outcome_quote: "impedire accessi al report dopo la scadenza",
  },
  redteam_experiment: {
    target: "A booking service checks availability and then writes a reservation. Its outcome is no overlapping confirmed reservations.",
    red_team_request: "Test whether concurrent requests can create overlapping confirmed reservations.",
    allowed_actions: "Use two operator-owned accounts through the normal web and mobile interfaces and inspect their confirmations.",
  },
  adversarial_review: {
    artifact: "La lista rimuove un elemento quando lo scontrino contiene lo stesso nome, senza considerare quantità o destinatario.",
    review_request: "Trova le rotture strutturali che rendono inaffidabile la rimozione automatica.",
  },
  premortem_scan: {
    plan: "Alle 18:00 viene inviata una mail con CSV. Alle 07:00 la reception importa il CSV. Entro le 07:30 i membri vedono la sala corretta.",
    premortem_question: "Come potrebbe fallire l'obiettivo che i membri vedano la sala corretta entro le 07:30?",
  },
};

function validate(tool: CanaryTool, output: string): boolean {
  const input = fixtures[tool];
  if (tool === "stress_structure") return validateStressStructureOutput(output, (input as StressStructureInput).artifact_excerpt) !== undefined;
  if (tool === "sparring_pressure") return validateSparringPressureOutput(output, (input as SparringPressureInput).target_quote) !== undefined;
  if (tool === "premortem_trace") {
    const value = input as PremortemTraceInput;
    return validatePremortemTraceOutput(output, value.plan_excerpt, value.failure_condition_quote, value.assumed_failure) !== undefined;
  }
  if (tool === "abuse_path") {
    const value = input as AbusePathInput;
    return validateAbusePathOutput(output, value.access_quote, value.control_quote, value.protected_outcome_quote) !== undefined;
  }
  if (tool === "redteam_experiment") return validateRedteamExperimentOutput(output) !== undefined;
  if (tool === "adversarial_review") return validateAdversarialReviewOutput(output) !== undefined;
  return validatePremortemScanOutput(output) !== undefined;
}

describe("GroqCloud targeted adversarial four-model canary", () => {
  it.skipIf(process.env.RUN_GROQ_CANARY !== "1")("runs every production tool once on a capability-matched reasoning model", async () => {
    const target = canaryResultPath("groq-four-model-adversarial-canary-2026-07-18.json");
    const apiKey = process.env.GROQ_API_KEY?.trim();
    expect(apiKey, "GROQ_API_KEY must be supplied by the operator environment").toBeTruthy();
    const results: Array<Record<string, unknown>> = [];

    let previousModel = "";
    for (const run of runs) {
        // Free-plan TPM is per model. Space a model's second bounded call; never retry a rejected request.
        if (run.model === previousModel) await new Promise(resolveDelay => setTimeout(resolveDelay, 20_000));
        previousModel = run.model;
        const tool = run.tool;
        const started = Date.now();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: run.model,
            messages: [
              { role: "system", content: systemPrompt(tool) },
              { role: "user", content: modelMaterial(tool, fixtures[tool]) },
            ],
            reasoning_effort: run.reasoningEffort,
            reasoning_format: "hidden",
            temperature: run.temperature,
            top_p: 0.95,
            max_completion_tokens: 4096,
            stream: false,
          }),
          signal: AbortSignal.timeout(150_000),
        });
        const latencyMs = Date.now() - started;
        const envelope = await response.json() as Record<string, any>;
        const output = envelope?.choices?.[0]?.message?.content ?? "";
        results.push({
          model: run.model,
          tool,
          http_status: response.status,
          finish_reason: envelope?.choices?.[0]?.finish_reason ?? null,
          latency_ms: latencyMs,
          prompt_tokens: envelope?.usage?.prompt_tokens ?? null,
          completion_tokens: envelope?.usage?.completion_tokens ?? null,
          reasoning_tokens: envelope?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
          shape_valid: response.ok && typeof output === "string" && validate(tool, output),
          output,
          error: response.ok ? null : envelope?.error ?? envelope,
        });
    }

    writeFileSync(target, JSON.stringify({
      generated_at: new Date().toISOString(),
      provider: "GroqCloud",
      endpoint,
      design: "Seven total calls: each production tool once, assigned to one of four capability-matched models.",
      settings: { reasoning: "maximum supported per model", reasoning_format: "hidden", max_completion_tokens: 4096, top_p: 0.95 },
      results,
    }, null, 2));

    console.log(`GROQ_CANARY_SUMMARY ${JSON.stringify(results.map(({ model, tool, http_status, latency_ms, shape_valid }) => ({ model, tool, http_status, latency_ms, shape_valid })))}`);
    expect(results).toHaveLength(7);
  }, 900_000);
});

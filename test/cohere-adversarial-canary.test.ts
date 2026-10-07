// @ts-expect-error Certification runs in Node while the Worker project intentionally omits Node types.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  modelMaterial,
  systemPrompt,
  type AbusePathInput,
  type AdversarialReviewInput,
  type PremortemTraceInput,
  type RedteamExperimentInput,
  type SparringInput,
  type SparringToolName,
} from "../src/sparring/request";
import {
  validateAbusePathOutput,
  validateAdversarialReviewOutput,
  validatePremortemTraceOutput,
  validateRedteamExperimentOutput,
} from "../src/sparring/service";
import { canaryResultPath } from "./canary-output";

declare const process: { env: Record<string, string | undefined>; cwd(): string };

const endpoint = "https://api.cohere.com/v2/chat";
const fixtures: Partial<Record<SparringToolName, SparringInput>> = {
  premortem_trace: {
    plan_excerpt: "Ogni ordine lascia il magazzino entro due ore. La linea completa un ordine prima di iniziare il successivo. Gli ordini grandi non hanno un tempo massimo.",
    target_quote: "La linea completa un ordine prima di iniziare il successivo.",
    outcome_quote: "Ogni ordine lascia il magazzino entro due ore.",
    failure_condition_quote: "Gli ordini grandi non hanno un tempo massimo.",
    assumed_failure: "Un ordine resta in attesa e non lascia il magazzino entro due ore.",
  },
  adversarial_review: {
    artifact: "La lista rimuove un elemento quando lo scontrino contiene lo stesso nome, senza considerare quantità o destinatario.",
    review_request: "Trova le rotture strutturali che rendono inaffidabile la rimozione automatica.",
  },
  redteam_experiment: {
    target: "A booking service checks availability and then writes a reservation. Its outcome is no overlapping confirmed reservations.",
    red_team_request: "Test whether concurrent requests can create overlapping confirmed reservations.",
    allowed_actions: "Use two operator-owned accounts through the normal web and mobile interfaces and inspect their confirmations.",
  },
  abuse_path: {
    artifact_excerpt: "Gli utenti autenticati possono condividere un link firmato. Il link firmato scade dopo dieci minuti. Il validatore accetta il link se è stato emesso prima della scadenza, senza controllare l'ora della richiesta. L'obiettivo è impedire accessi al report dopo la scadenza.",
    access_quote: "possono condividere un link firmato",
    control_quote: "Il link firmato scade dopo dieci minuti",
    protected_outcome_quote: "impedire accessi al report dopo la scadenza",
  },
};

const runs = [
  { model: "command-a-reasoning-08-2025", tool: "premortem_trace", thinking: true },
  { model: "command-a-reasoning-08-2025", tool: "adversarial_review", thinking: true },
  { model: "command-a-plus-05-2026", tool: "redteam_experiment", thinking: false },
  { model: "command-r-plus-08-2024", tool: "abuse_path", thinking: false },
] as const satisfies ReadonlyArray<{ model: string; tool: SparringToolName; thinking: boolean }>;

function validate(tool: SparringToolName, output: string, input: SparringInput): boolean {
  if (tool === "premortem_trace") {
    const value = input as PremortemTraceInput;
    return validatePremortemTraceOutput(output, value.plan_excerpt, value.failure_condition_quote, value.assumed_failure) !== undefined;
  }
  if (tool === "adversarial_review") return validateAdversarialReviewOutput(output) !== undefined;
  if (tool === "redteam_experiment") return validateRedteamExperimentOutput(output) !== undefined;
  const value = input as AbusePathInput;
  return validateAbusePathOutput(output, value.access_quote, value.control_quote, value.protected_outcome_quote) !== undefined;
}

describe("Cohere targeted adversarial canary", () => {
  it.skipIf(process.env.RUN_COHERE_CANARY !== "1")("runs four capability-matched production packets", async () => {
    const target = canaryResultPath("cohere-four-call-adversarial-canary-2026-07-18.json");
    const apiKey = process.env.COHERE_API_KEY?.trim();
    expect(apiKey, "COHERE_API_KEY must be supplied by the operator environment").toBeTruthy();
    const results: Array<Record<string, unknown>> = [];

    for (const run of runs) {
      const input = fixtures[run.tool];
      expect(input).toBeTruthy();
      const started = Date.now();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-name": "op-redteam-mcp-canary",
        },
        body: JSON.stringify({
          model: run.model,
          messages: [
            { role: "system", content: systemPrompt(run.tool) },
            { role: "user", content: modelMaterial(run.tool, input!) },
          ],
          ...(run.thinking ? { thinking: { type: "enabled" } } : {}),
          max_tokens: 4096,
          temperature: 0.3,
          p: 0.9,
        }),
        signal: AbortSignal.timeout(150_000),
      });
      const latencyMs = Date.now() - started;
      const envelope = await response.json() as Record<string, any>;
      const content = Array.isArray(envelope?.message?.content) ? envelope.message.content : [];
      const output = content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n").trim();
      const thinkingTokens = content.filter((item: any) => item?.type === "thinking").reduce((sum: number, item: any) => sum + String(item.thinking ?? "").length, 0);
      results.push({
        model: run.model,
        tool: run.tool,
        http_status: response.status,
        finish_reason: envelope?.finish_reason ?? null,
        latency_ms: latencyMs,
        input_tokens: envelope?.usage?.tokens?.input_tokens ?? envelope?.meta?.tokens?.input_tokens ?? null,
        output_tokens: envelope?.usage?.tokens?.output_tokens ?? envelope?.meta?.tokens?.output_tokens ?? null,
        thinking_characters_observed: thinkingTokens,
        shape_valid: response.ok && envelope?.finish_reason === "COMPLETE" && validate(run.tool, output, input!),
        output,
        error: response.ok ? null : envelope,
      });
    }

    writeFileSync(target, JSON.stringify({
      generated_at: new Date().toISOString(),
      provider: "Cohere",
      endpoint,
      design: "Four total calls across three capability-matched Cohere models; no retry or fallback.",
      results,
    }, null, 2));
    console.log(`COHERE_CANARY_SUMMARY ${JSON.stringify(results.map(({ model, tool, http_status, latency_ms, shape_valid }) => ({ model, tool, http_status, latency_ms, shape_valid })))}`);
    expect(results).toHaveLength(4);
  }, 600_000);
});

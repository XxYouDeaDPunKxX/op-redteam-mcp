// @ts-expect-error Certification runs in Node while the Worker project omits Node types.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelMaterial, systemPrompt, type AdversarialReviewInput, type PremortemTraceInput, type StressStructureInput } from "../src/sparring/request";
import { validateAdversarialReviewOutput, validatePremortemTraceOutput, validateStressStructureOutput } from "../src/sparring/service";
import { canaryResultPath } from "./canary-output";

declare const process: { env: Record<string, string | undefined>; cwd(): string };

const runs = [
  {
    provider: "mistral", model: "magistral-small-latest", tool: "premortem_trace",
    endpoint: "https://api.mistral.ai/v1/chat/completions", keyVariable: "MISTRAL_API_KEY",
    input: {
      plan_excerpt: "Ogni ordine lascia il magazzino entro due ore. La linea completa un ordine prima di iniziare il successivo. Gli ordini grandi non hanno un tempo massimo.",
      target_quote: "La linea completa un ordine prima di iniziare il successivo.",
      outcome_quote: "Ogni ordine lascia il magazzino entro due ore.",
      failure_condition_quote: "Gli ordini grandi non hanno un tempo massimo.",
      assumed_failure: "Un ordine resta in attesa e non lascia il magazzino entro due ore.",
    } satisfies PremortemTraceInput,
  },
  {
    provider: "github", model: "microsoft/phi-4-reasoning", tool: "stress_structure",
    endpoint: "https://models.github.ai/inference/chat/completions", keyVariable: "GITHUB_MODELS_API_KEY",
    input: {
      artifact_excerpt: "Il sistema usa il solo orario di inizio per evitare sovrapposizioni.",
      target_quote: "usa il solo orario di inizio",
      outcome_quote: "evitare sovrapposizioni",
      attack_lens: "boundary",
      claim_under_test: "Orari di inizio differenti sono sufficienti a evitare sovrapposizioni.",
    } satisfies StressStructureInput,
  },
  {
    provider: "github", model: "deepseek/deepseek-r1-0528", tool: "adversarial_review",
    endpoint: "https://models.github.ai/inference/chat/completions", keyVariable: "GITHUB_MODELS_API_KEY",
    input: {
      artifact: "La lista rimuove un elemento quando lo scontrino contiene lo stesso nome, senza considerare quantità o destinatario.",
      review_request: "Trova le rotture strutturali che rendono inaffidabile la rimozione automatica.",
    } satisfies AdversarialReviewInput,
  },
] as const;

function valid(run: typeof runs[number], output: string): boolean {
  if (run.tool === "premortem_trace") {
    const value = run.input as PremortemTraceInput;
    return validatePremortemTraceOutput(output, value.plan_excerpt, value.failure_condition_quote, value.assumed_failure) !== undefined;
  }
  if (run.tool === "stress_structure") return validateStressStructureOutput(output, (run.input as StressStructureInput).artifact_excerpt) !== undefined;
  return validateAdversarialReviewOutput(output) !== undefined;
}

describe("Mistral and GitHub Models fast admission canary", () => {
  it.skipIf(process.env.RUN_NEW_FREE_ROUTES_CANARY !== "1")("runs only three targeted model calls", async () => {
    const target = canaryResultPath("mistral-github-three-call-canary-2026-07-18.json");
    const results: Array<Record<string, unknown>> = [];
    for (const run of runs.filter(candidate => !(process.env.SKIP_MISTRAL_CANARY === "1" && candidate.provider === "mistral"))) {
      const key = process.env[run.keyVariable]?.trim();
      expect(key, `${run.keyVariable} must be supplied by the operator environment`).toBeTruthy();
      const started = Date.now();
      const response = await fetch(run.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: run.model,
          messages: [
            { role: "system", content: systemPrompt(run.tool) },
            { role: "user", content: modelMaterial(run.tool, run.input) },
          ],
          temperature: 0.3,
          top_p: 0.95,
          max_tokens: 2048,
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await response.text();
      let envelope: Record<string, any>;
      try { envelope = JSON.parse(raw) as Record<string, any>; }
      catch { envelope = { error: { type: "non_json_provider_response", message: raw.slice(0, 500) } }; }
      const output = envelope?.choices?.[0]?.message?.content ?? "";
      results.push({
        provider: run.provider, model: run.model, tool: run.tool,
        http_status: response.status, latency_ms: Date.now() - started,
        finish_reason: envelope?.choices?.[0]?.finish_reason ?? null,
        input_tokens: envelope?.usage?.prompt_tokens ?? null,
        output_tokens: envelope?.usage?.completion_tokens ?? null,
        shape_valid: response.ok && typeof output === "string" && valid(run, output),
        output,
        error: response.ok ? null : envelope?.error ?? envelope,
      });
    }
    writeFileSync(target, JSON.stringify({ generated_at: new Date().toISOString(), design: "Three targeted calls only; no retry or fallback.", results }, null, 2));
    console.log(`NEW_FREE_ROUTES_SUMMARY ${JSON.stringify(results.map(({ provider, model, tool, http_status, latency_ms, shape_valid }) => ({ provider, model, tool, http_status, latency_ms, shape_valid })))}`);
    expect(results).toHaveLength(process.env.SKIP_MISTRAL_CANARY === "1" ? 2 : 3);
  }, 300_000);
});

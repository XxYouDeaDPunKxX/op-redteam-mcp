import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthorizationHandler } from "../src/auth/github";
import { resolveRuntimeOrigin } from "../src/auth/origin";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { LogSinkConfig, StandardLogEvent } from "../src/log-sink";
import { base64UrlEncode } from "../src/security/encoding";
import { publicDiagnosticCategory, runAdversarialTool } from "../src/server";
import { GPT_OSS_ROLLBACK_MODEL } from "../src/sparring/request";

const key = base64UrlEncode(new Uint8Array(32).fill(9));

interface LocalFetchHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const localWorker = worker as unknown as LocalFetchHandler;

function authorizationHandler(): LocalFetchHandler {
  return createAuthorizationHandler(resolveRuntimeOrigin("https://op.example")) as unknown as LocalFetchHandler;
}

function executionContext(onWaitUntil?: (promise: Promise<unknown>) => void): ExecutionContext {
  return {
    props: {},
    waitUntil: onWaitUntil ? vi.fn(onWaitUntil) : vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function localEnv(options?: { rateAllowed?: boolean; candidate?: unknown; sink?: LogSinkConfig }): Env & LogSinkConfig {
  const candidate = options?.candidate ?? "A bounded provider candidate.";
  const candidateText = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
  return {
    AUTH_MODE: "none",
    PUBLIC_ORIGIN: "http://localhost:8787",
    MCP_RESOURCE: "http://localhost:8787",
    COGNITIVE_RUNTIME_PROFILE: "cloudflare_rollback",
    NVIDIA_API_KEY: "nvidia-test-key",
    OPENROUTER_API_KEY: "openrouter-test-key",
    IDENTITY_HMAC_KEY: key,
    COOKIE_ENCRYPTION_KEY: key,
    ALLOWED_GITHUB_USER_IDS: "999999999999999",
    ALLOWED_DCR_REDIRECT_URIS: "https://client.example/oauth/callback",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    AI: {
      run: vi.fn().mockImplementation((model: string) =>
        Promise.resolve(
          model === GPT_OSS_ROLLBACK_MODEL
            ? {
                object: "response",
                status: "completed",
                error: null,
                incomplete_details: null,
                output: [
                  { type: "reasoning", content: [{ type: "reasoning_text", text: "private reasoning" }] },
                  {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: candidateText }],
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } },
              }
            : {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: candidateText, refusal: null, tool_calls: [] },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
              },
        ),
      ),
    },
    RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: options?.rateAllowed ?? true }) },
    ANALYTICS: { writeDataPoint: vi.fn() },
    VERSION_METADATA: { id: "local-v1", tag: "", timestamp: "" },
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as Env["OAUTH_PROVIDER"],
    ...options?.sink,
  };
}

async function mcp(env: Env, body: unknown, url = "http://localhost:8787/mcp"): Promise<Response> {
  return localWorker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
    env,
    executionContext(),
  );
}

const sinkConfig: LogSinkConfig = {
  LOG_SINK_ENABLED: "true",
  LOG_SINK_URL: "https://logs.example.test/events",
  LOG_SINK_TOKEN: "test-token",
};

const validStressInput = {
  artifact_excerpt: "A causes B.",
  target_quote: "A",
  outcome_quote: "B",
  attack_lens: "failure_path",
  claim_under_test: "A causes B.",
};

const validStressCandidate = "what_breaks: A is not sufficient\nevidence: A";

describe("generic telemetry log sink integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("emits the approved event for a public MCP success", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = executionContext((promise) => pending.push(promise));
    const env = localEnv({ candidate: validStressCandidate, sink: sinkConfig });
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await runAdversarialTool("stress_structure", validStressInput, { github_user_id: 999999999999999, login: "local" }, env, ctx);
    await Promise.all(pending);

    expect(response).toMatchObject({ content: [{ text: validStressCandidate }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as StandardLogEvent;
    expect(event).toMatchObject({
      schemaVersion: "1",
      source: "op-redteam-mcp",
      tool: "stress_structure",
      outcome: "ok",
      request: validStressInput,
      response,
    });
  });

  it("does not emit secret-detected results", async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const secretInput = {
      ...validStressInput,
      artifact_excerpt: `Token sk-${"a".repeat(24)}`,
      target_quote: "Token",
      outcome_quote: "Token",
    };
    const secretResponse = await runAdversarialTool("stress_structure", secretInput, { github_user_id: 999999999999999, login: "local" }, localEnv({ sink: sinkConfig }), executionContext());

    expect(secretResponse).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("secret_detected") }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("screens secrets before rate limiting can schedule a sink event", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = executionContext((promise) => pending.push(promise));
    const secretInput = {
      ...validStressInput,
      artifact_excerpt: `Token sk-${"a".repeat(24)}`,
      target_quote: "Token",
      outcome_quote: "Token",
    };
    const env = localEnv({ rateAllowed: false, sink: sinkConfig });
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await runAdversarialTool("stress_structure", secretInput, { github_user_id: 999999999999999, login: "local" }, env, ctx);
    await Promise.all(pending);

    expect(response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("secret_detected") }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("emits a rate-limited event without provider usage or latency", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = executionContext((promise) => pending.push(promise));
    const env = localEnv({ rateAllowed: false, sink: sinkConfig });
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await runAdversarialTool("stress_structure", validStressInput, { github_user_id: 999999999999999, login: "local" }, env, ctx);
    await Promise.all(pending);

    expect(response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("rate_limited") }] });
    const event = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as StandardLogEvent;
    expect(event).toMatchObject({ outcome: "rate_limited", providerLatencyMs: 0 });
    expect(event).not.toHaveProperty("usage");
  });

  it("isolates sink failure from the MCP result and records only generic diagnostics", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = executionContext((promise) => pending.push(promise));
    const env = localEnv({ candidate: validStressCandidate, sink: sinkConfig });
    const fetcher = vi.fn<Fetcher>(async () => {
      throw new Error("sink token and request body must not escape");
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await runAdversarialTool("stress_structure", validStressInput, { github_user_id: 999999999999999, login: "local" }, env, ctx);
    await expect(Promise.all(pending)).resolves.toHaveLength(1);

    const expected = await runAdversarialTool("stress_structure", validStressInput, { github_user_id: 999999999999999, login: "local" }, localEnv({ candidate: validStressCandidate }), executionContext());
    expect(response).toEqual(expected);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledWith({
      indexes: [expect.any(String)],
      blobs: ["log_sink_delivery_failed", "stress_structure"],
    });
    expect(JSON.stringify(vi.mocked(env.ANALYTICS.writeDataPoint).mock.calls)).not.toContain("test-token");
    expect(JSON.stringify(vi.mocked(env.ANALYTICS.writeDataPoint).mock.calls)).not.toContain("logs.example.test");
  });
});

describe("stateless MCP Worker integration", () => {
  it("does not expose unsupported routes", async () => {
    const response = await mcp(localEnv(), {}, "http://localhost:8787/unsupported/run");
    expect(response.status).toBe(404);
  });

  it("publishes only allowlisted diagnostic categories", () => {
    expect(publicDiagnosticCategory("provider_capacity")).toBe("provider_capacity");
    expect(publicDiagnosticCategory("provider_provider_bad_gateway")).toBe("provider_bad_gateway");
    expect(publicDiagnosticCategory("provider_provider_service_unavailable")).toBe("provider_service_unavailable");
    expect(publicDiagnosticCategory("provider_provider_gateway_timeout")).toBe("provider_gateway_timeout");
    expect(publicDiagnosticCategory("stress_shape_mismatch")).toBe("stress_shape_mismatch");
    expect(publicDiagnosticCategory("scan_aspect_not_verbatim")).toBe("scan_aspect_not_verbatim");
    expect(publicDiagnosticCategory("raw upstream detail: secret-value")).toBe("unspecified");
    expect(publicDiagnosticCategory(undefined)).toBeUndefined();
  });

  it("returns a safe provider diagnostic in text without success-only structured content", async () => {
    const env = localEnv();
    vi.mocked(env.AI.run).mockRejectedValueOnce({ code: 3040, detail: "must not escape" });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A causa B.",
          target_quote: "A",
          outcome_quote: "B",
          attack_lens: "failure_path",
          claim_under_test: "A è sufficiente a causare B.",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, string> };
    };
    const expected = {
      code: "critic_unavailable",
      stage: "provider",
      diagnostic_category: "provider_capacity",
      retry_policy: "operator_only",
    };
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content[0]!.text)).toEqual(expected);
    expect(payload.result.structuredContent).toBeUndefined();
    expect(payload.result.content[0]!.text).not.toContain("must not escape");
  });

  it("returns a safe postflight diagnostic in text without success-only structured content", async () => {
    const env = localEnv({ candidate: "Here is an unstructured analysis." });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A causa B.",
          target_quote: "A",
          outcome_quote: "B",
          attack_lens: "failure_path",
          claim_under_test: "A è sufficiente a causare B.",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, string> };
    };
    const expected = {
      code: "invalid_model_output",
      stage: "postflight",
      diagnostic_category: "stress_shape_mismatch",
      retry_policy: "operator_only",
    };
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content[0]!.text)).toEqual(expected);
    expect(payload.result.structuredContent).toBeUndefined();
  });

  it("initializes and advertises exactly eight read-only OAuth tools", async () => {
    const env = localEnv();
    const initialized = await mcp(env, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "1" } },
    });
    expect(initialized.status).toBe(200);
    const initializedPayload = (await initialized.json()) as { result: { instructions: string; serverInfo: Record<string, unknown> } };
    expect(initializedPayload).toMatchObject({
      result: {
        serverInfo: { name: "OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges", version: "3.9.3" },
        instructions: expect.any(String),
      },
    });

    const listed = await mcp(env, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const payload = (await listed.json()) as { result: { tools: Array<Record<string, unknown>> } };
    expect(JSON.stringify({ instructions: initializedPayload.result.instructions, tools: payload.result.tools })).not.toMatch(/\b(?:GPT|ChatGPT)\b/i);
    expect(payload.result.tools).toHaveLength(8);
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "stress_structure",
      "sparring_pressure",
      "premortem_trace",
      "abuse_path",
      "redteam_experiment",
      "adversarial_review",
      "premortem_scan",
      "sparring_scan",
    ]);
    expect(payload.result.tools.map((tool) => Object.keys((tool.outputSchema as { properties: Record<string, unknown> }).properties))).toEqual([
      ["status", "what_breaks", "evidence"],
      ["property", "variation", "effect"],
      ["status", "trace"],
      ["status", "path"],
      ["experiment"],
      ["review"],
      ["premortem"],
      ["status", "mechanism", "aspect", "variation", "pressure"],
    ]);
    expect(payload.result.tools[0]).toMatchObject({
      name: "stress_structure",
      title: "Stress Structure",
      description: "Test one explicit target-to-outcome claim. Returns one evidence-anchored challenge or NO GROUNDED BREAK. The calling model triages the candidate; no fixes or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["artifact_excerpt", "target_quote", "outcome_quote", "attack_lens", "claim_under_test"],
        properties: {
          claim_under_test: { description: "One declarative relation between target_quote and outcome_quote, using the source's own certainty." },
        },
      },
      securitySchemes: [{ type: "oauth2", scopes: ["review:invoke"] }],
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["review:invoke"] }] },
    });
    expect(payload.result.tools[1]).toMatchObject({
      name: "sparring_pressure",
      title: "Sparring Pressure",
      description: "Pressure one early idea with one hypothetical mechanism and direct effect. The calling model supplies one target, outcome, and lens, then triages the candidate. No findings, fixes, or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["idea_excerpt", "target_quote", "intended_outcome", "challenge_lens"],
        properties: {
          idea_excerpt: { description: "Self-contained excerpt containing target_quote and enough context to understand intended_outcome." },
        },
      },
    });
    expect(payload.result.tools[0]).toMatchObject({ outputSchema: { description: "Flat connector-compatible projection. status determines candidate-field presence; the runtime never emits grounded_break without both what_breaks and evidence. The calling model must triage logical grounding and usefulness before use." } });
    expect(payload.result.tools[2]).toMatchObject({
      name: "premortem_trace",
      title: "Premortem Trace",
      description: "Trace one stated failure condition through one plan target to one assumed failure. Returns one causal hypothesis or NO GROUNDED TRACE. The calling model triages it; no cause list, fixes, or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["plan_excerpt", "target_quote", "outcome_quote", "failure_condition_quote", "assumed_failure"],
        properties: {
          plan_excerpt: { description: "Self-contained plan excerpt containing target_quote, outcome_quote, and failure_condition_quote." },
          failure_condition_quote: { description: expect.stringContaining("If none exists, do not call") },
          assumed_failure: { description: expect.stringContaining("prepared by the calling model") },
        },
      },
    });
    expect(payload.result.tools[2]).toMatchObject({ outputSchema: { description: "Flat connector-compatible projection. status determines trace presence; the runtime never emits trace status without trace content. The calling model must triage causal grounding and usefulness before use." } });
    expect(payload.result.tools[3]).toMatchObject({
      name: "abuse_path",
      title: "Abuse Path",
      description: "Trace one supplied access through one control to one protected outcome. Returns one hypothetical abuse path or NO GROUNDED PATH. The calling model triages it; no threat list, fixes, or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["artifact_excerpt", "access_quote", "control_quote", "protected_outcome_quote"],
        properties: {
          artifact_excerpt: { description: "Self-contained excerpt containing access_quote, control_quote, and protected_outcome_quote." },
          access_quote: { description: expect.stringContaining("no unstated capability or compressed action chain") },
          control_quote: { description: expect.stringContaining("If none exists, do not call") },
          protected_outcome_quote: { description: expect.stringContaining("do not synthesize") },
        },
      },
    });
    expect(payload.result.tools[3]).toMatchObject({ outputSchema: { description: "Flat connector-compatible projection. status determines path presence; the runtime never emits abuse_path status without path content. The calling model must triage feasibility, grounding, and usefulness before use." } });
    expect(payload.result.tools[4]).toMatchObject({
      name: "redteam_experiment",
      title: "Red-Team Experiment",
      description: "Design one authorized, falsifiable experiment against a supplied target. The calling model provides the complete action and observation boundary, then triages the candidate. No execution, fixes, or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["target", "red_team_request", "allowed_actions"],
        properties: {
          target: { maxLength: 16_000, description: "Self-contained target facts and stated outcome needed to design one experiment." },
          red_team_request: { maxLength: 2_000, description: expect.stringContaining("prepared by the calling model") },
          allowed_actions: { maxLength: 2_000, description: expect.stringContaining("Complete set") },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["experiment"],
        properties: {
          experiment: { maxLength: 6_000 },
        },
      },
    });
    expect(payload.result.tools[5]).toMatchObject({
      name: "adversarial_review",
      title: "Adversarial Review",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["artifact", "review_request"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["review"],
        properties: { review: { maxLength: 12_000 } },
      },
    });
    expect.soft(payload.result.tools[5]!.description).toEqual(
      expect.stringContaining("The model behind the tool selects candidate breaks and smallest fixes"),
    );
    expect(payload.result.tools[6]).toMatchObject({
      name: "premortem_scan",
      title: "Premortem Scan",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "premortem_question"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["premortem"],
        properties: {
          premortem: { maxLength: 4_000 },
        },
      },
    });
    expect.soft(payload.result.tools[6]!.description).toEqual(
      expect.stringContaining("The model behind the tool proposes one hypothesis and causal path"),
    );
    expect(payload.result.tools[7]).toMatchObject({
      name: "sparring_scan",
      title: "Sparring Scan",
      description: "Openly select and pressure one load-bearing mechanism in an early idea when the calling model has only the idea and exact intended outcome. Returns one mechanism-preserving pressure candidate or no grounded pressure. The calling model triages grounding, preservation, causal support, and usefulness; no findings, fixes, retries, or decisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["idea", "intended_outcome"],
        properties: {
          idea: { maxLength: 16_000, description: expect.stringContaining("Add no target, lens, aspect, variation, cause, or desired answer") },
          intended_outcome: { maxLength: 500, description: "Exact one-line declarative substring naming the idea's stated outcome." },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { enum: ["pressure", "no_grounded_pressure"] },
          mechanism: { maxLength: 500 },
          aspect: { maxLength: 300 },
          variation: { maxLength: 300 },
          pressure: { maxLength: 600 },
        },
      },
    });
    expect(payload.result.tools[0]).toMatchObject({
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            enum: ["grounded_break", "no_grounded_break"],
            description: expect.stringContaining("not a semantic usability judgment"),
          },
          what_breaks: { description: "Present only for grounded_break. One candidate logical challenge to the supplied relation." },
          evidence: { description: "Present only for grounded_break. Verbatim evidence validated against artifact_excerpt." },
        },
      },
    });
    expect(payload.result.tools[1]).toMatchObject({
      outputSchema: {
        type: "object",
        additionalProperties: false,
        description: "One validated-shape hypothetical mechanism candidate. The calling model must triage grounding, directness, and usefulness before use.",
        required: ["property", "variation", "effect"],
        properties: {
          property: { maxLength: 200, description: "Compatibility field containing the first mechanism slot." },
          variation: { maxLength: 200, description: "The hypothetical change applied to that factor." },
          effect: { maxLength: 300, description: "The candidate direct effect on intended_outcome." },
        },
      },
    });
    expect(payload.result.tools[2]).toMatchObject({
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            enum: ["trace", "no_grounded_trace"],
            description: expect.stringContaining("not a final causal or usability judgment"),
          },
          trace: {
            maxLength: 800,
            description: "Present only for trace status. One candidate path from the supplied condition through the target to the assumed failure. Treat it as a hypothesis.",
          },
        },
      },
    });
    expect(payload.result.tools[3]).toMatchObject({
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            enum: ["abuse_path", "no_grounded_path"],
            description: expect.stringContaining("not a final feasibility or usability judgment"),
          },
          path: {
            maxLength: 1_000,
            description: "Present only for abuse_path status. One candidate path from the supplied access through the supplied control to the protected outcome. Intentional use is hypothetical.",
          },
        },
      },
    });
    expect(payload.result.tools.every((tool) => String(tool.description).toLowerCase().includes("triage"))).toBe(true);
    expect(
      payload.result.tools.every((tool) =>
        /The calling model must (?:triage|classify)/.test(String((tool.outputSchema as { description?: string }).description))),
    ).toBe(true);
    expect(payload.result.tools.every((tool) => !("idempotentHint" in (tool.annotations as object)))).toBe(true);
  });

  it("executes and projects one adversarial review", async () => {
    const candidate = [
      "what_breaks: La cancellazione per solo nome elimina anche bisogni ancora validi.",
      "evidence: Il piano confronta soltanto il nome e ignora quantità e destinatario.",
      "fix: Richiedere una corrispondenza strutturale che includa il contesto necessario alla rimozione.",
    ].join("\n");
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "adversarial_review",
        arguments: {
          artifact: "Il piano confronta soltanto il nome e ignora quantità e destinatario.",
          review_request: "Trova le rotture strutturali che rendono inaffidabile la rimozione automatica.",
        },
      },
    });
    const payload = (await response.json()) as { result: { structuredContent: Record<string, string> } };
    expect(payload.result.structuredContent).toEqual({ review: candidate });
  });

  it("executes and projects one premortem scan", async () => {
    const candidate = [
      "hypothesis: Il CSV non viene allegato all'invio delle 18:00.",
      "path: il computer della reception non trova l'allegato -> l'importazione non avviene alle 07:00 -> i membri non vedono la sala corretta entro le 07:30",
    ].join("\n");
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "premortem_scan",
        arguments: {
          plan: "Alle 18:00 viene inviata una mail con CSV. Alle 07:00 la reception importa il CSV. Entro le 07:30 i membri devono vedere la sala corretta.",
          premortem_question: "Come potrebbe fallire l'obiettivo che i membri vedano la sala corretta entro le 07:30?",
        },
      },
    });
    const payload = (await response.json()) as { result: { structuredContent: Record<string, string> } };
    expect(payload.result.structuredContent).toEqual({ premortem: candidate });
  });

  it("executes and projects one red-team experiment", async () => {
    const candidate = [
      "attack: Edit the claim after its first approval.",
      "procedure: Create and approve version one, edit it through the normal interface, obtain the second approval, then inspect version, history, and payment preview.",
      "failure_signal: The payment preview selects a version that lacks two approvals in its history.",
      "assumption: Approval state remains attached after the claim is edited.",
    ].join("\n");
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "redteam_experiment",
        arguments: {
          target: "Claims require two distinct approvals before payment and can be edited after the first approval.",
          red_team_request: "Test whether an edit between approvals can violate the two-approval outcome.",
          allowed_actions: "Create one operator-owned claim, approve it with two operator-controlled accounts, edit it normally, and inspect its version, history, and payment preview.",
        },
      },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe(candidate);
    expect(payload.result.structuredContent).toEqual({ experiment: candidate });
  });

  it("executes focused structure stress with plain validated text output", async () => {
    const artifact = "Per evitare sovrapposizioni, il calendario accetta una riunione quando il suo orario di inizio è diverso da quelli esistenti.";
    const candidate = [
      "what_breaks: Due riunioni con inizi diversi possono comunque occupare lo stesso intervallo.",
      "evidence: il calendario accetta una riunione quando il suo orario di inizio è diverso da quelli esistenti",
    ].join("\n");
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: artifact,
          target_quote: "accetta una riunione quando il suo orario di inizio è diverso",
          outcome_quote: "evitare sovrapposizioni",
          attack_lens: "boundary",
          claim_under_test: "Orari di inizio differenti sono sufficienti a evitare sovrapposizioni.",
        },
      },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { content: Array<{ type: string; text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe(candidate);
    expect(payload.result.structuredContent).toEqual({
      status: "grounded_break",
      what_breaks: "Due riunioni con inizi diversi possono comunque occupare lo stesso intervallo.",
      evidence: "il calendario accetta una riunione quando il suo orario di inizio è diverso da quelli esistenti",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const request = vi.mocked(env.AI.run).mock.calls[0]?.[1] as { input: string };
    expect(JSON.parse(request.input)).toEqual({
      TARGET: "accetta una riunione quando il suo orario di inizio è diverso",
      EXPLICIT_OUTCOME: "evitare sovrapposizioni",
      ATTACK_LENS: "boundary",
      CLAIM_UNDER_TEST: "Orari di inizio differenti sono sufficienti a evitare sovrapposizioni.",
      ORIGINAL_ARTIFACT: artifact,
    });
    expect(request).not.toHaveProperty("response_format");
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    const telemetry = JSON.stringify(vi.mocked(env.ANALYTICS.writeDataPoint).mock.calls[0]?.[0]);
    expect(telemetry).not.toContain(artifact);
    expect(telemetry).not.toContain(candidate);
  });

  it("executes one sparring pressure mechanism", async () => {
    const idea = "Una biblioteca apre tutta la notte per aumentare l'accesso degli studenti.";
    const candidate = "mechanism: durata di apertura :: apertura notturna sottoutilizzata -> accesso degli studenti invariato";
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "sparring_pressure",
        arguments: {
          idea_excerpt: idea,
          target_quote: "apre tutta la notte",
          intended_outcome: "aumentare l'accesso degli studenti",
          challenge_lens: "consequence",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe(candidate);
    expect(payload.result.structuredContent).toEqual({
      property: "durata di apertura",
      variation: "apertura notturna sottoutilizzata",
      effect: "accesso degli studenti invariato",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("executes and projects one open sparring scan on direct NVIDIA", async () => {
    const idea =
      "Il servizio mantiene una coda prioritaria con precedenza agli ordini urgenti per consegnare ogni ordine urgente entro due ore.";
    const candidate = [
      "MECHANISM: coda prioritaria con precedenza agli ordini urgenti",
      "ASPECT: precedenza agli ordini urgenti",
      "VARIATION: la precedenza resta attiva ma viene applicata dopo il primo ciclo di lavorazione",
      "PRESSURE: gli ordini urgenti entrano nel ciclo iniziale ordinario -> la consegna entro due ore diventa dipendente dalla durata di quel ciclo",
    ].join("\n");
    const env = localEnv();
    env.COGNITIVE_RUNTIME_PROFILE = "external";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: candidate, refusal: null, tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await mcp(env, {
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: {
          name: "sparring_scan",
          arguments: {
            idea,
            intended_outcome: "consegnare ogni ordine urgente entro due ore",
          },
        },
      });
      const payload = (await response.json()) as {
        result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
      };
      expect(payload.result.content[0]!.text).toBe(candidate);
      expect(payload.result.structuredContent).toEqual({
        status: "pressure",
        mechanism: "coda prioritaria con precedenza agli ordini urgenti",
        aspect: "precedenza agli ordini urgenti",
        variation: "la precedenza resta attiva ma viene applicata dopo il primo ciclo di lavorazione",
        pressure: "gli ordini urgenti entrano nel ciclo iniziale ordinario -> la consegna entro due ore diventa dipendente dalla durata di quel ciclo",
      });
      expect(env.AI.run).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(request).toMatchObject({
        model: "nvidia/nemotron-3-super-120b-a12b",
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 8_192,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(request.chat_template_kwargs).not.toHaveProperty("low_effort");
      expect(JSON.parse(request.messages[1].content)).toEqual({
        INTENDED_OUTCOME: "consegnare ogni ordine urgente entro due ore",
        ORIGINAL_IDEA: idea,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects the exact no-grounded-pressure sentinel", async () => {
    const env = localEnv();
    env.COGNITIVE_RUNTIME_PROFILE = "external";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "NO GROUNDED PRESSURE" } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await mcp(env, {
        jsonrpc: "2.0",
        id: 47,
        method: "tools/call",
        params: {
          name: "sparring_scan",
          arguments: {
            idea: "La coda prioritaria consegna gli ordini urgenti entro due ore.",
            intended_outcome: "consegna gli ordini urgenti entro due ore",
          },
        },
      });
      const payload = (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, string> };
      };
      expect(payload.result.isError).not.toBe(true);
      expect(payload.result.content[0]!.text).toBe("NO GROUNDED PRESSURE");
      expect(payload.result.structuredContent).toEqual({ status: "no_grounded_pressure" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects a shape-valid but semantically weak scan candidate for caller triage", async () => {
    const idea =
      "Il servizio mantiene una coda prioritaria con precedenza agli ordini urgenti per consegnare ogni ordine urgente entro due ore.";
    const candidate = [
      "MECHANISM: coda prioritaria con precedenza agli ordini urgenti",
      "ASPECT: precedenza agli ordini urgenti",
      "VARIATION: la precedenza resta attiva e viene aumentata",
      "PRESSURE: la precedenza rafforza la consegna entro due ore",
    ].join("\n");
    const env = localEnv();
    env.COGNITIVE_RUNTIME_PROFILE = "external";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: candidate } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await mcp(env, {
        jsonrpc: "2.0",
        id: 48,
        method: "tools/call",
        params: {
          name: "sparring_scan",
          arguments: { idea, intended_outcome: "consegnare ogni ordine urgente entro due ore" },
        },
      });
      const payload = (await response.json()) as {
        result: { isError?: boolean; structuredContent: Record<string, string> };
      };
      expect(payload.result.isError).not.toBe(true);
      expect(payload.result.structuredContent).toEqual({
        status: "pressure",
        mechanism: "coda prioritaria con precedenza agli ordini urgenti",
        aspect: "precedenza agli ordini urgenti",
        variation: "la precedenza resta attiva e viene aumentata",
        pressure: "la precedenza rafforza la consegna entro due ore",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails an open sparring scan closed before inference in rollback mode", async () => {
    const env = localEnv();
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 46,
      method: "tools/call",
      params: {
        name: "sparring_scan",
        arguments: {
          idea: "La coda prioritaria consegna gli ordini urgenti entro due ore.",
          intended_outcome: "consegna gli ordini urgenti entro due ore",
        },
      },
    });
    const payload = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content[0]!.text)).toEqual({
      code: "critic_failed",
      stage: "provider",
      diagnostic_category: "provider_configuration",
      retry_policy: "operator_only",
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("executes one grounded premortem trace", async () => {
    const plan =
      "Ogni ordine lascia il magazzino entro due ore. La linea completa un ordine prima di iniziare il successivo. Gli ordini grandi non hanno un tempo massimo.";
    const candidate =
      "trace: Gli ordini grandi non hanno un tempo massimo -> la linea resta occupata prima di iniziare il successivo -> Un ordine resta in attesa e non lascia il magazzino entro due ore.";
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "premortem_trace",
        arguments: {
          plan_excerpt: plan,
          target_quote: "La linea completa un ordine prima di iniziare il successivo.",
          outcome_quote: "Ogni ordine lascia il magazzino entro due ore.",
          failure_condition_quote: "Gli ordini grandi non hanno un tempo massimo.",
          assumed_failure: "Un ordine resta in attesa e non lascia il magazzino entro due ore.",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe(candidate);
    expect(payload.result.structuredContent).toEqual({
      status: "trace",
      trace:
        "Gli ordini grandi non hanno un tempo massimo -> la linea resta occupata prima di iniziare il successivo -> Un ordine resta in attesa e non lascia il magazzino entro due ore.",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("returns a deterministic no-grounded-trace projection", async () => {
    const plan = "Preparo la borsa da palestra la sera. La borsa resta accanto alla porta fino al mattino, così esco senza dimenticare nulla.";
    const env = localEnv({ candidate: "NO GROUNDED TRACE" });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "premortem_trace",
        arguments: {
          plan_excerpt: plan,
          target_quote: "Preparo la borsa da palestra la sera",
          outcome_quote: "esco senza dimenticare nulla",
          failure_condition_quote: "La borsa resta accanto alla porta fino al mattino",
          assumed_failure: "Al mattino esco di casa dimenticando qualcosa.",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe("NO GROUNDED TRACE");
    expect(payload.result.structuredContent).toEqual({ status: "no_grounded_trace" });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("executes one anchored intentional abuse path", async () => {
    const artifact =
      "Gli utenti autenticati possono condividere un link firmato. Il link firmato scade dopo dieci minuti. Il validatore accetta il link se è stato emesso prima della scadenza, senza controllare l'ora della richiesta. L'obiettivo è impedire accessi al report dopo la scadenza.";
    const candidate =
      "path: possono condividere un link firmato dopo averlo ottenuto -> Il link firmato scade dopo dieci minuti è sconfitto perché il validatore controlla solo l'ora di emissione -> impedire accessi al report dopo la scadenza viene meno";
    const env = localEnv({ candidate });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: {
        name: "abuse_path",
        arguments: {
          artifact_excerpt: artifact,
          access_quote: "possono condividere un link firmato",
          control_quote: "Il link firmato scade dopo dieci minuti",
          protected_outcome_quote: "impedire accessi al report dopo la scadenza",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe(candidate);
    expect(payload.result.structuredContent).toEqual({
      status: "abuse_path",
      path:
        "possono condividere un link firmato dopo averlo ottenuto -> Il link firmato scade dopo dieci minuti è sconfitto perché il validatore controlla solo l'ora di emissione -> impedire accessi al report dopo la scadenza viene meno",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("returns a deterministic no-grounded-path projection", async () => {
    const artifact = "Gli utenti possono aprire un report. L'accesso richiede una sessione valida. Il risultato protetto è limitare il report agli utenti autenticati.";
    const env = localEnv({ candidate: "NO GROUNDED PATH" });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: {
        name: "abuse_path",
        arguments: {
          artifact_excerpt: artifact,
          access_quote: "possono aprire un report",
          control_quote: "L'accesso richiede una sessione valida",
          protected_outcome_quote: "limitare il report agli utenti autenticati",
        },
      },
    });
    const payload = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, string> };
    };
    expect(payload.result.content[0]!.text).toBe("NO GROUNDED PATH");
    expect(payload.result.structuredContent).toEqual({ status: "no_grounded_path" });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("rejects missing fields and ungrounded stress quotes at the MCP boundary", async () => {
    const cases = [
      { name: "sparring_pressure", arguments: {} },
      { name: "sparring_scan", arguments: {} },
      { name: "premortem_trace", arguments: {} },
      { name: "abuse_path", arguments: {} },
      {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A supports B.",
          target_quote: "missing",
          outcome_quote: "B",
          attack_lens: "dependency",
          claim_under_test: "A is sufficient to support B.",
        },
      },
      {
        name: "abuse_path",
        arguments: {
          artifact_excerpt: "A can cross B to protect C.",
          access_quote: "missing",
          control_quote: "B",
          protected_outcome_quote: "C",
        },
      },
      {
        name: "abuse_path",
        arguments: {
          artifact_excerpt: "A can cross B to protect C.",
          access_quote: "A",
          control_quote: "A",
          protected_outcome_quote: "C",
        },
      },
      {
        name: "premortem_trace",
        arguments: {
          plan_excerpt: "A causes B.",
          target_quote: "missing",
          outcome_quote: "B",
          failure_condition_quote: "A",
          assumed_failure: "B does not occur.",
        },
      },
      {
        name: "premortem_trace",
        arguments: {
          plan_excerpt: "A causes B.",
          target_quote: "A",
          outcome_quote: "B",
          failure_condition_quote: "missing",
          assumed_failure: "B does not occur.",
        },
      },
      {
        name: "premortem_trace",
        arguments: {
          plan_excerpt: "A causes B.",
          target_quote: "A",
          outcome_quote: "B",
          failure_condition_quote: "A",
          assumed_failure: "Could B fail?",
        },
      },
      {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A supports B.",
          target_quote: "A",
          outcome_quote: "B",
          attack_lens: "general_review",
          claim_under_test: "A is sufficient to support B.",
        },
      },
      {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A supports B.",
          target_quote: "A",
          outcome_quote: "B",
          attack_lens: "dependency",
          claim_under_test: "Is A sufficient to support B?",
        },
      },
      {
        name: "sparring_scan",
        arguments: {
          idea: "La coda prioritaria consegna gli ordini urgenti entro due ore.",
          intended_outcome: "Gli ordini arrivano domani.",
        },
      },
      {
        name: "sparring_scan",
        arguments: {
          idea: "La coda prioritaria consegna gli ordini urgenti entro due ore.",
          intended_outcome: "consegna gli ordini urgenti entro due ore?",
        },
      },
      {
        name: "sparring_scan",
        arguments: {
          idea: "La coda prioritaria consegna gli ordini urgenti entro due ore.",
          intended_outcome: "consegna gli ordini urgenti entro due ore",
          challenge_lens: "tradeoff",
        },
      },
    ];
    for (const params of cases) {
      const env = localEnv();
      const response = await mcp(env, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params,
      });
      const payload = (await response.json()) as { error?: unknown; result?: unknown };
      expect(payload.error).toBeDefined();
      expect(payload.result).toBeUndefined();
      expect(env.AI.run).not.toHaveBeenCalled();
    }
  });

  it("returns a stable MCP tool error when the local review limit is exceeded", async () => {
    const env = localEnv({ rateAllowed: false });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "sparring_pressure",
        arguments: {
          idea_excerpt: "A bounded idea.",
          target_quote: "bounded idea",
          intended_outcome: "remain bounded",
          challenge_lens: "assumption",
        },
      },
    });
    const payload = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0]!.text).toBe('{"code":"rate_limited","stage":"rate_limit","retry_policy":"operator_only"}');
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("applies the shared review limit before the provider call", async () => {
    const env = localEnv({ rateAllowed: false });
    const response = await mcp(env, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "stress_structure",
        arguments: {
          artifact_excerpt: "A causes B.",
          target_quote: "A",
          outcome_quote: "B",
          attack_lens: "failure_path",
          claim_under_test: "A is sufficient to cause B.",
        },
      },
    });
    const payload = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0]!.text).toBe('{"code":"rate_limited","stage":"rate_limit","retry_policy":"operator_only"}');
    expect(env.RATE_LIMITER.limit).toHaveBeenCalledTimes(1);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects alternate origins and oversized MCP ingress before the SDK", async () => {
    const alternate = await mcp(localEnv(), { jsonrpc: "2.0" }, "http://127.0.0.1:8787/mcp");
    expect(alternate.status).toBe(421);

    const env = localEnv();
    const oversized = await localWorker.fetch(
      new Request("http://localhost:8787/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(73_729),
      }),
      env,
      executionContext(),
    );
    expect(oversized.status).toBe(413);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

interface AuthHarness {
  env: Env;
  provider: {
    parseAuthRequest: ReturnType<typeof vi.fn>;
    lookupClient: ReturnType<typeof vi.fn>;
    completeAuthorization: ReturnType<typeof vi.fn>;
  };
}

function authHarness(allowedIds = "999999999999999"): AuthHarness {
  const provider = {
    parseAuthRequest: vi.fn().mockResolvedValue({
      responseType: "code",
      clientId: "test-mcp-client",
      redirectUri: "https://client.example/oauth/callback",
      scope: ["review:invoke"],
      state: "d".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      resource: "https://op.example",
    }),
    lookupClient: vi.fn().mockResolvedValue({
      clientId: "test-mcp-client",
      redirectUris: ["https://client.example/oauth/callback"],
      clientName: "Test MCP client <untrusted>",
      tokenEndpointAuthMethod: "none",
    }),
    completeAuthorization: vi.fn().mockResolvedValue({ redirectTo: "https://client.example/oauth/callback?code=mcp-code" }),
  };
  return {
    provider,
    env: {
      ...localEnv(),
      AUTH_MODE: "github",
      PUBLIC_ORIGIN: "https://op.example",
      MCP_RESOURCE: "https://op.example",
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ALLOWED_GITHUB_USER_IDS: allowedIds,
      OAUTH_PROVIDER: provider as unknown as Env["OAUTH_PROVIDER"],
    },
  };
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

async function beginApproval(harness: AuthHarness) {
  const handler = authorizationHandler();
  const consent = await handler.fetch!(new Request("https://op.example/authorize?request=1"), harness.env, executionContext());
  const html = await consent.text();
  const csrf = /name="csrf_state" value="([^"]+)"/.exec(html)?.[1];
  const authorizeCookie = consent.headers.get("Set-Cookie");
  if (!csrf || !authorizeCookie) throw new Error("consent setup failed");
  const approved = await handler.fetch!(
    new Request("https://op.example/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookiePair(authorizeCookie),
      },
      body: new URLSearchParams({ decision: "approve", csrf_state: csrf }),
    }),
    harness.env,
    executionContext(),
  );
  const github = new URL(approved.headers.get("Location")!);
  const setCookies = approved.headers.getSetCookie();
  const callbackCookie = setCookies.find((value) => value.startsWith("__Secure-op_callback_v1="));
  if (!callbackCookie) throw new Error("callback cookie missing");
  return { handler, github, callbackCookie: cookiePair(callbackCookie) };
}

describe("GitHub OAuth authorization integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET renders escaped consent but never begins GitHub or completes authorization", async () => {
    const harness = authHarness();
    const handler = authorizationHandler();
    const response = await handler.fetch!(new Request("https://op.example/authorize?request=1"), harness.env, executionContext());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Test MCP client &lt;untrusted&gt;");
    expect(html).toContain("OP Adversarial Pressure MCP tools");
    expect(html).not.toContain("closed-packet");
    expect(html).toContain("review:invoke");
    expect(html).toContain("https://op.example");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("uses a generic fallback when the OAuth client name is absent", async () => {
    const harness = authHarness();
    harness.provider.lookupClient.mockResolvedValueOnce({
      clientId: "test-mcp-client",
      redirectUris: ["https://client.example/oauth/callback"],
      clientName: undefined,
      tokenEndpointAuthMethod: "none",
    });
    const handler = authorizationHandler();
    const response = await handler.fetch!(new Request("https://op.example/authorize?request=1"), harness.env, executionContext());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<strong>MCP client</strong> requests permission to invoke the OP Adversarial Pressure MCP tools.");
    expect(html).not.toContain("ChatGPT");
    expect(html).not.toContain("closed-packet");
    expect(html).toContain("review:invoke");
    expect(html).toContain("https://op.example");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("requires the encrypted cookie and exact CSRF token on POST", async () => {
    const harness = authHarness();
    const handler = authorizationHandler();
    const response = await handler.fetch!(
      new Request("https://op.example/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ decision: "approve", csrf_state: "wrong" }),
      }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("denial returns downstream access_denied without starting GitHub", async () => {
    const harness = authHarness();
    const handler = authorizationHandler();
    const consent = await handler.fetch!(new Request("https://op.example/authorize?request=1"), harness.env, executionContext());
    const html = await consent.text();
    const csrf = /name="csrf_state" value="([^"]+)"/.exec(html)![1]!;
    const response = await handler.fetch!(
      new Request("https://op.example/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiePair(consent.headers.get("Set-Cookie")!) },
        body: new URLSearchParams({ decision: "deny", csrf_state: csrf }),
      }),
      harness.env,
      executionContext(),
    );
    const target = new URL(response.headers.get("Location")!);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("d".repeat(43));
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("approval starts GitHub with empty scope and PKCE S256 in a distinct callback cookie", async () => {
    const harness = authHarness();
    const { github } = await beginApproval(harness);
    expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("scope")).toBe("");
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
    expect(github.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(github.searchParams.get("state")).not.toBe("d".repeat(43));
  });

  it("allows numeric ID, revokes upstream token, and persists only numeric ID plus login", async () => {
    const harness = authHarness("999999999999999");
    const { handler, github, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-upstream-token-123456", scope: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 999999999999999, login: "RenamedLogin" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("code=mcp-code");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/applications/github-client/token");
    expect(harness.provider.completeAuthorization).toHaveBeenCalledWith({
      request: expect.objectContaining({ state: "d".repeat(43), resource: "https://op.example" }),
      userId: "github-999999999999999",
      metadata: {},
      scope: ["review:invoke"],
      props: { github_user_id: 999999999999999, login: "renamedlogin" },
      revokeExistingGrants: true,
      revokeExistingGrantsBatchSize: 50,
    });
    expect(JSON.stringify(harness.provider.completeAuthorization.mock.calls)).not.toContain("github-upstream-token");
  });

  it("denies a different numeric ID reusing an allowed login, after revocation", async () => {
    const harness = authHarness("999999999999999");
    const { handler, github, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-upstream-token-123456", scope: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 99999999, login: "RenamedLogin" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects unexpected returned scope, revokes, and never calls the user endpoint or completes a grant", async () => {
    const harness = authHarness();
    const { handler, github, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-upstream-token-123456", scope: "repo" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("issues no grant when upstream revocation fails", async () => {
    const harness = authHarness();
    const { handler, github, callbackCookie } = await beginApproval(harness);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-upstream-token-123456", scope: "" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 999999999999999, login: "Allowed" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 })),
    );
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(502);
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("attempts revocation after an identity-network failure and issues no grant", async () => {
    const harness = authHarness();
    const { handler, github, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-upstream-token-123456", scope: "" }), { status: 200 }))
      .mockRejectedValueOnce(new Error("network detail must not escape"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/applications/github-client/token");
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a malformed numeric allowlist before requesting an upstream token", async () => {
    const harness = authHarness("not-a-numeric-id");
    const { handler, github, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request(`https://op.example/callback?code=github-code&state=${github.searchParams.get("state")}`, {
        headers: { Cookie: callbackCookie },
      }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects altered callback state and deletes the callback cookie before any GitHub call", async () => {
    const harness = authHarness();
    const { handler, callbackCookie } = await beginApproval(harness);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler.fetch!(
      new Request("https://op.example/callback?code=github-code&state=altered-state", { headers: { Cookie: callbackCookie } }),
      harness.env,
      executionContext(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

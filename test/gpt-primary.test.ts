import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { executeAdversarial } from "../src/sparring/service";
import { runAdversarialTool } from "../src/server";
import type { SparringInput, SparringToolName } from "../src/sparring/request";
import { base64UrlEncode } from "../src/security/encoding";

const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/providers/gpt-transport", () => ({ invokeGptAuto: transport }));
const trace = { modelsGet: 1, requirementsPost: 1, conversationPost: 1, sseEvents: 2, sseBytes: 100, streamComplete: true };
const cases: [SparringToolName, SparringInput, string, string][] = [
  ["stress_structure", { artifact_excerpt: "A overlaps B", target_quote: "A", outcome_quote: "B", attack_lens: "boundary", claim_under_test: "A prevents B" }, "NO GROUNDED BREAK", "nvidia/nemotron-3-ultra-550b-a55b"],
  ["adversarial_review", { artifact: "A overlaps B", review_request: "Find the failure" }, "what_breaks: overlap", "nvidia/nemotron-3-ultra-550b-a55b"],
  ["sparring_pressure", { idea_excerpt: "A prevents B", target_quote: "A", intended_outcome: "prevent B", challenge_lens: "assumption" }, "mechanism: A :: absent -> B", "nvidia/nemotron-3-super-120b-a12b"],
  ["sparring_scan", { idea: "A prevents B", intended_outcome: "prevent B" }, "NO GROUNDED PRESSURE", "nvidia/nemotron-3-super-120b-a12b"],
  ["redteam_experiment", { target: "A prevents B", red_team_request: "Test A", allowed_actions: "Observe B" }, "attack: observe B", "nvidia/nemotron-3-ultra-550b-a55b"],
  ["premortem_trace", { plan_excerpt: "A prevents B", target_quote: "A", outcome_quote: "B", failure_condition_quote: "A", assumed_failure: "B" }, "NO GROUNDED TRACE", "nvidia/nemotron-3-ultra-550b-a55b:free"],
  ["premortem_scan", { plan: "A prevents B", premortem_question: "Why did B occur?" }, "hypothesis: A absent", "nvidia/nemotron-3-ultra-550b-a55b:free"],
  ["abuse_path", { artifact_excerpt: "A controls B for C", access_quote: "A", control_quote: "B", protected_outcome_quote: "C" }, "NO GROUNDED PATH", "nvidia/nemotron-3-ultra-550b-a55b:free"],
];
const identity = { github_user_id: 12345, login: "test-operator" };
function runtime() {
  const tokenFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: "test-token", deviceId: "test-device", refreshed: true })));
  const env = {
    AUTH_MODE: "none", COGNITIVE_RUNTIME_PROFILE: "external", COGNITIVE_GPT_PRIMARY_ENABLED: "true",
    IDENTITY_HMAC_KEY: base64UrlEncode(new Uint8Array(32).fill(7)), NVIDIA_API_KEY: "test-native", OPENROUTER_API_KEY: "test-native",
    RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) }, AI: { run: vi.fn() },
    ANALYTICS: { writeDataPoint: vi.fn() },
    GPT_ACCOUNT: { idFromName: vi.fn(() => "account-id"), get: vi.fn(() => ({ fetch: tokenFetch })) },
  } as unknown as Env;
  return { env, tokenFetch };
}
function native(content: string) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] })));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => { transport.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("optional account primary", () => {
  it.each(cases)("uses one ChatGPT generation for %s", async (tool, input, output) => {
    const { env, tokenFetch } = runtime();
    const fetcher = native("wrong route");
    transport.mockResolvedValue({ ok: true, content: output, model: "auto-reported", trace });
    const result = await executeAdversarial(tool, input, identity, env);
    expect(result).toMatchObject({ kind: "success", text: output, providerMeta: { selectedProvider: "chatgpt", reportedModel: "auto-reported", gptConversationPosts: 1, nativePosts: 0, tokenRefreshed: true } });
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(cases)("falls directly to the original native model for %s", async (tool, input, output, model) => {
    const { env } = runtime();
    transport.mockResolvedValue({ ok: false, error: { category: "quota", status: 429 }, trace });
    const fetcher = native(output);
    const result = await executeAdversarial(tool, input, identity, env);
    expect(result).toMatchObject({ kind: "success", text: output, providerMeta: { selectedProvider: "native", gptConversationPosts: 1, nativePosts: 1, primaryFailure: "quota" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).model).toBe(model);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "false", "1"])("keeps native behavior without credential reads when flag=%s", async (flag) => {
    const { env, tokenFetch } = runtime();
    env.COGNITIVE_GPT_PRIMARY_ENABLED = flag;
    native("NO GROUNDED BREAK");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "success", text: "NO GROUNDED BREAK" });
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([401, 403])("fails closed on account HTTP %i", async (status) => {
    const { env, tokenFetch } = runtime(); tokenFetch.mockResolvedValue(new Response("{}", { status }));
    const fetcher = native("NO GROUNDED BREAK");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", providerMeta: { selectedProvider: null, nativePosts: 0 } });
    expect(fetcher).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(["model_refusal", "secret_like_output", "additional_challenge", "provider_authentication"])("fails closed on %s", async (category) => {
    const { env } = runtime(); transport.mockResolvedValue({ ok: false, error: { category, status: 403 }, trace });
    const fetcher = native("NO GROUNDED BREAK");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", providerMeta: { nativePosts: 0 } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("screens secrets before malformed output can fall back", async () => {
    const { env } = runtime(); transport.mockResolvedValue({ ok: true, content: `malformed sk-${"a".repeat(24)}`, model: "auto", trace });
    const fetcher = native("NO GROUNDED BREAK");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", diagnosticCode: "provider_secret_like_output" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("falls back once for malformed primary and never retries malformed native", async () => {
    const { env } = runtime(); transport.mockResolvedValue({ ok: true, content: "bad shape", model: "auto", trace });
    const fetcher = native("bad shape");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", diagnosticCode: "stress_shape_mismatch", providerMeta: { nativePosts: 1, primaryFailure: "invalid_model_output" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects secret input before rate, account, or provider access", async () => {
    const { env, tokenFetch } = runtime(); const fetcher = native("unused");
    expect(await executeAdversarial("adversarial_review", { artifact: `sk-${"a".repeat(24)}`, review_request: "Review" }, identity, env)).toMatchObject({ code: "secret_detected" });
    expect(env.RATE_LIMITER.limit).not.toHaveBeenCalled(); expect(tokenFetch).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rate limits before account access", async () => {
    const { env, tokenFetch } = runtime(); vi.mocked(env.RATE_LIMITER.limit).mockResolvedValue({ success: false });
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toEqual({ kind: "rate_limited" });
    expect(tokenFetch).not.toHaveBeenCalled();
  });
  it("keeps rollback behavior without reading an account even when the primary flag is enabled", async () => {
    const { env, tokenFetch } = runtime(); env.COGNITIVE_RUNTIME_PROFILE = "cloudflare_rollback";
    vi.mocked(env.AI.run).mockResolvedValue({ object: "response", status: "completed", error: null, incomplete_details: null, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NO GROUNDED BREAK" }] }] });
    const fetcher = native("unused");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "success", text: "NO GROUNDED BREAK" });
    expect(tokenFetch).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "unavailable"])("falls back once when credential state is %s", async (condition) => {
    const { env, tokenFetch } = runtime();
    if (condition === "missing") delete env.GPT_ACCOUNT;
    if (condition === "malformed") tokenFetch.mockResolvedValue(Response.json({ accessToken: "" }));
    if (condition === "unavailable") tokenFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    const fetcher = native("NO GROUNDED BREAK");
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "success", providerMeta: { selectedProvider: "native", gptConversationPosts: 0, nativePosts: 1, primaryFailure: "credential_unavailable" } });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
  });
  it("caps credential plus GPT time at 45s then shares the remaining 105s with native", async () => {
    vi.useFakeTimers(); const { env, tokenFetch } = runtime();
    tokenFetch.mockImplementation(() => new Promise(() => {}));
    const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    vi.stubGlobal("fetch", fetcher);
    const pending = executeAdversarial(cases[0]![0], cases[0]![1], identity, env);
    await vi.waitFor(() => expect(tokenFetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(45_000); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(105_000);
    expect(await pending).toMatchObject({ kind: "error", providerMeta: { nativePosts: 1, primaryFailure: "deadline" } });
    expect(transport).not.toHaveBeenCalled();
  });
  it("adds safe MCP metadata without changing text and structured contracts", async () => {
    const { env } = runtime(); transport.mockResolvedValue({ ok: true, content: "NO GROUNDED BREAK", model: "auto", trace }); native("unused");
    const result = await runAdversarialTool("stress_structure", cases[0]![1], identity, env);
    expect(result).toMatchObject({ content: [{ type: "text", text: "NO GROUNDED BREAK" }], _meta: { "op-adversarial/provider": { selectedProvider: "chatgpt" } } });
    expect(result.structuredContent).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("test-token");
  });
});

describe("real transport through the public service", () => {
  async function useRealTransport() {
    const actual = await vi.importActual<typeof import("../src/providers/gpt-transport")>("../src/providers/gpt-transport");
    transport.mockImplementation(actual.invokeGptAuto);
  }
  function fixtureNetwork(output: string, conversationStatus = 200, streamSuffix = "") {
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const address = String(url);
      if (address.includes("/models?")) return Response.json({ models: [{ slug: "auto" }] });
      if (address.endsWith("/chat-requirements")) return Response.json({ token: "fixture-requirement" });
      if (address.endsWith("/f/conversation")) {
        if (conversationStatus !== 200) return new Response("{}", { status: conversationStatus });
        const message = { id: "fixture-a", author: { role: "assistant" }, channel: "final", status: "finished_successfully", content: { content_type: "text", parts: [output] }, metadata: { model_slug: "gpt-fixture" } };
        return new Response(`data: ${JSON.stringify({ message })}\n\n${streamSuffix}`, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: output } }] });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it.each(cases)("keeps %s in one real ChatGPT conversation POST", async (tool, input, output) => {
    await useRealTransport(); const { env } = runtime(); const fetcher = fixtureNetwork(output);
    expect(await executeAdversarial(tool, input, identity, env)).toMatchObject({ kind: "success", text: output, providerMeta: { selectedProvider: "chatgpt", reportedModel: "gpt-fixture", gptConversationPosts: 1, nativePosts: 0 } });
    const posts = fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/f/conversation") && init?.method === "POST");
    expect(posts).toHaveLength(1);
    const request = JSON.parse(posts[0]![1]!.body as string);
    expect(request.model).toBe("auto"); expect(request.messages).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("chat/completions"))).toBe(false);
  });
  it.each(cases)("falls from a real quota failure to %s's original native model", async (tool, input, output, model) => {
    await useRealTransport(); const { env } = runtime(); const fetcher = fixtureNetwork(output, 429);
    expect(await executeAdversarial(tool, input, identity, env)).toMatchObject({ kind: "success", text: output, providerMeta: { selectedProvider: "native", primaryFailure: "quota_or_rate_limited", gptConversationPosts: 1, nativePosts: 1 } });
    const calls = fetcher.mock.calls.filter(([url]) => String(url).includes("chat/completions"));
    expect(calls).toHaveLength(1); expect(JSON.parse(calls[0]![1]!.body as string).model).toBe(model);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/f/conversation"))).toHaveLength(1);
  });
  it.each([401, 403])("never falls back after real conversation HTTP %i", async (status) => {
    await useRealTransport(); const { env } = runtime(); const fetcher = fixtureNetwork("NO GROUNDED BREAK", status);
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", providerMeta: { nativePosts: 0 } });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("chat/completions"))).toBe(false);
  });
  it("preserves secret fail-closed behavior after an observed stream error", async () => {
    await useRealTransport(); const { env } = runtime(); const fetcher = fixtureNetwork(`sk-${"a".repeat(24)}`, 200, 'event: error\ndata: {"error":"fixture-error"}\n\n');
    expect(await executeAdversarial(cases[0]![0], cases[0]![1], identity, env)).toMatchObject({ kind: "error", diagnosticCode: "provider_secret_like_output", providerMeta: { nativePosts: 0 } });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("chat/completions"))).toBe(false);
  });
  it.each(["secret", "refusal"])("preserves observed %s when a real stream hangs until the primary deadline", async (kind) => {
    vi.useFakeTimers(); await useRealTransport(); const { env } = runtime();
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const address = String(url);
      if (address.includes("/models?")) return Response.json({ models: [] });
      if (address.endsWith("/chat-requirements")) return Response.json({ token: "fixture" });
      if (address.endsWith("/f/conversation")) {
        const message = { id: "fixture-a", author: { role: "assistant" }, channel: "final", status: "in_progress", content: { content_type: "text", parts: [kind === "secret" ? `sk-${"a".repeat(24)}` : "Refused"] }, metadata: { model_slug: "gpt-fixture", ...(kind === "refusal" ? { refusal: true } : {}) } };
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ message })}\n\n`)); } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error("Native fallback forbidden");
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = executeAdversarial(cases[0]![0], cases[0]![1], identity, env);
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/f/conversation"))).toBe(true));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toMatchObject({ kind: "error", diagnosticCode: kind === "secret" ? "provider_secret_like_output" : "provider_model_refusal", providerMeta: { nativePosts: 0, gptConversationPosts: 1 } });
    expect(fetcher.mock.calls).toHaveLength(3);
  });
});

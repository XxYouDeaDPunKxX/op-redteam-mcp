import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeGptAuto } from "../src/providers/gpt-transport";

const snapshot = (text = "Visible result", id = "answer", extra = {}) => ({ message: {
  id, author: { role: "assistant" }, channel: "final", status: "finished_successfully",
  content: { content_type: "text", parts: [text] }, metadata: { model_slug: "gpt-6" }, ...extra,
} });
const event = (value: unknown, name = "") => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
function serve(stream: string | ReadableStream<Uint8Array>, requirements: unknown = { token: "sentinel-fixture" }) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    if (requests.length % 3 === 1) return Response.json({ models: [{ slug: "auto" }] });
    if (requests.length % 3 === 2) return Response.json(requirements);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  return requests;
}
const run = (signal = new AbortController().signal) => invokeGptAuto("fixture-token", "fixture-device", "Review", { target: "fixture" }, signal);
afterEach(() => vi.unstubAllGlobals());

describe("bounded account conversation transport", () => {
  it("sends one authenticated fresh conversation per packet with a stable device", async () => {
    const requests = serve(event(snapshot()));
    const first = await run(); const second = await run();
    expect(first).toMatchObject({ ok: true, content: "Visible result", model: "gpt-6", trace: { modelsGet: 1, requirementsPost: 1, conversationPost: 1, streamComplete: true } });
    expect(second.ok).toBe(true);
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      expect(request.headers.get("oai-device-id")).toBe("fixture-device");
    }
    const body1 = await requests[2]!.json() as Record<string, any>;
    const body2 = await requests[5]!.json() as Record<string, any>;
    expect(body1).toMatchObject({ model: "auto", action: "next", force_use_sse: true, force_use_search: false, supported_encodings: ["v1"] });
    expect(body1).not.toHaveProperty("conversation_id");
    expect(body1.messages[0].content.parts[0]).toContain('"target":"fixture"');
    expect(body1.parent_message_id).not.toBe(body2.parent_message_id);
    expect(requests[2]!.headers.get("openai-sentinel-chat-requirements-token")).toBe("sentinel-fixture");
  });

  it("preserves a packet already serialized by the public runtime", async () => {
    const requests = serve(event(snapshot()));
    await invokeGptAuto("fixture-token", "fixture-device", "Review", '{"target":"fixture"}', new AbortController().signal);
    const body = await requests[2]!.json() as Record<string, any>;
    expect(body.messages[0].content.parts[0]).toBe('Review\n\n{"target":"fixture"}');
  });

  it("reconstructs compact and nested patches while hiding other channels", async () => {
    serve(event(snapshot("hidden", "hidden", { channel: "analysis" }))
      + event(snapshot("", "a", { status: "in_progress" }))
      + event({ p: "/message/content/parts/0", o: "append", v: "Bad" }, "delta")
      + event({ delta: { path: "/message/content/parts/0", operation: "replace", value: "Hello" } }, "delta")
      + event({ p: "/message/content/parts/0", o: "append", v: " world" }, "delta")
      + event({ p: "/message/content/parts/0", o: "truncate", v: 5 }, "delta")
      + event({ p: "", o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }] }, "delta"));
    expect(await run()).toMatchObject({ ok: true, content: "Hello" });
  });

  it("does not inherit completion or model from a replaced final message", async () => {
    serve(event(snapshot("old")) + event({ v: snapshot("new", "new", { status: "in_progress", metadata: {} }) }, "delta") + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: false, error: { category: "completion_unconfirmed" } });
  });

  it("clears inherited completion when a pointer changes the message identity", async () => {
    serve(event(snapshot("old")) + event({ p: "/message/id", o: "replace", v: "new" }, "delta")
      + event({ p: "/message/content/parts/0", o: "replace", v: "new" }, "delta"));
    expect(await run()).toMatchObject({ ok: false, error: { category: "completion_unconfirmed" } });
  });

  it("never returns an inherited model after identity change and fresh completion", async () => {
    serve(event(snapshot("old")) + event({ p: "/message/id", o: "replace", v: "new" }, "delta")
      + event({ p: "/message/content/parts/0", o: "replace", v: "new" }, "delta")
      + event({ p: "/message/status", o: "replace", v: "finished_successfully" }, "delta"));
    expect(await run()).toMatchObject({ ok: false, error: { category: "model_unobserved" } });
  });

  it("correlates stream completion and ignores deltas for a different message", async () => {
    serve(event(snapshot("ready", "a", { status: "in_progress" }))
      + event({ message_id: "b", p: "/message/content/parts/0", o: "append", v: "wrong" }, "delta")
      + event({ type: "message_stream_complete", message_id: "b" }) + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: false, error: { category: "completion_unconfirmed" } });
    serve(event(snapshot("ready", "a", { status: "in_progress" })) + event({ type: "message_stream_complete", message_id: "a" }));
    expect(await run()).toMatchObject({ ok: true, content: "ready" });
  });

  it.each([[401, "auth_rejected"], [403, "security_barrier"], [429, "quota_or_rate_limited"], [503, "catalog_unavailable"], [302, "catalog_unavailable"]])("categorizes status %s without retry", async (status, category) => {
    let count = 0;
    vi.stubGlobal("fetch", async () => { count++; return new Response(null, { status }); });
    expect(await run()).toMatchObject({ ok: false, error: { category, status } });
    expect(count).toBe(1);
  });

  it("stops before conversation when an account challenge is required", async () => {
    const requests = serve("", { token: "sentinel-fixture", proofofwork: { required: true } });
    expect(await run()).toMatchObject({ ok: false, error: { category: "additional_challenge_required" } });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["", "empty_response"],
    [event(snapshot("", "a", { status: "in_progress" })) + "data: [DONE]\n\n", "completion_unconfirmed"],
    ["data: broken\n\n", "malformed_sse"],
    [event(snapshot("ok")) + "data: truncated", "truncated_response"],
    ["data: " + "x".repeat(262145), "sse_size_limit"],
    [event(snapshot("x", "a", { metadata: { model_slug: "unsafe/model" } })), "model_unobserved"],
  ])("rejects invalid stream (case %#)", async (stream, category) => {
    serve(stream);
    expect(await run()).toMatchObject({ ok: false, error: { category } });
  });

  it.each([
    [snapshot("sk-" + "A".repeat(24)), "secret_like_output"],
    [snapshot("safe", "a", { metadata: { model_slug: "sk-" + "A".repeat(24) } }), "secret_like_output"],
    [snapshot("No", "a", { metadata: { refusal: true } }), "model_refusal"],
  ])("keeps a safety observation sticky after replacement and parse failure", async (bad, category) => {
    serve(event(bad) + event(snapshot("safe", "new")) + "data: malformed\n\n");
    expect(await run()).toMatchObject({ ok: false, error: { category } });
  });

  it("keeps secret detection sticky through a stream read exception", async () => {
    let sent = false;
    serve(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(event(snapshot("sk-" + "A".repeat(24))))); }
      else controller.error(new Error("private exception"));
    } }));
    expect(await run()).toMatchObject({ ok: false, error: { category: "secret_like_output" } });
  });

  it("keeps a secret observed between operations in a patch list sticky", async () => {
    serve(event(snapshot("safe", "a", { status: "in_progress" }))
      + event({ p: "", o: "patch", v: [
        { p: "/message/content/parts/0", o: "replace", v: "sk-" + "A".repeat(24) },
        { p: "/message/content/parts/0", o: "replace", v: "safe" },
        { p: "/message/status", o: "replace", v: "finished_successfully" },
      ] }, "delta"));
    expect(await run()).toMatchObject({ ok: false, error: { category: "secret_like_output" } });
  });

  it("accepts finish stop through split UTF-8 and CRLF event frames", async () => {
    const bytes = new TextEncoder().encode(event(snapshot("café", "a", {
      status: "in_progress", metadata: { model_slug: "gpt-6", finish_details: { type: "stop" } },
    })).replaceAll("\n", "\r\n"));
    serve(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    expect(await run()).toMatchObject({ ok: true, content: "café" });
  });

  it("categorizes network errors without returning diagnostics", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("private exception"); });
    const result = await run();
    expect(result).toMatchObject({ ok: false, error: { category: "network_error" } });
    expect(JSON.stringify(result)).not.toContain("private exception");
  });

  it("observes abort even when a response body stalls", async () => {
    const abort = new AbortController();
    serve(new ReadableStream({ start() {} }));
    const pending = run(abort.signal);
    setTimeout(() => abort.abort(), 5);
    expect(await pending).toMatchObject({ ok: false, error: { category: "aborted" } });
  });

  it("returns and cancels at DONE even when the connection stays open", async () => {
    let cancelled = false;
    const abort = new AbortController();
    serve(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event(snapshot()) + "data: [DONE]\n\n"));
    }, cancel() { cancelled = true; } }));
    const timer = setTimeout(() => abort.abort(), 30);
    try {
      expect(await run(abort.signal)).toMatchObject({ ok: true, content: "Visible result" });
      expect(cancelled).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("rejects DONE alone without waiting for a stalled connection", async () => {
    const abort = new AbortController();
    serve(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event(snapshot("pending", "a", { status: "in_progress" })) + "data: [DONE]\n\n"));
    } }));
    const timer = setTimeout(() => abort.abort(), 30);
    try { expect(await run(abort.signal)).toMatchObject({ ok: false, error: { category: "completion_unconfirmed" } }); }
    finally { clearTimeout(timer); }
  });

  it.each(["I cannot provide this.", "I can't help with this.", "I won’t answer.", "I am unable to comply."])("keeps explicit visible refusal sticky (case %#)", async text => {
    let sent = false;
    serve(new ReadableStream({ pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(event(snapshot(text)) + event(snapshot("safe", "b"))));
      } else controller.error(new Error("fixture read error"));
    } }));
    expect(await run()).toMatchObject({ ok: false, error: { category: "model_refusal" } });
  });

  it("treats a typed stream error as an error even without an event name", async () => {
    serve(event(snapshot()) + event({ type: "error", message: "fixture diagnostic" }));
    expect(await run()).toMatchObject({ ok: false, error: { category: "unclassified_stream_error" } });
  });

  it.each([
    [{ error: { status: 401 } }, "auth_rejected", 401],
    [{ type: "error", code: "authentication_error" }, "auth_rejected", undefined],
    [{ type: "authentication_error" }, "auth_rejected", undefined],
    [{ error: { status: 403 } }, "security_barrier", 403],
    [{ error: { code: "security_barrier" } }, "security_barrier", undefined],
    [{ type: "security_barrier" }, "security_barrier", undefined],
    [{ type: "error", error: { type: "model_refusal" } }, "model_refusal", undefined],
    [{ type: "model_refusal" }, "model_refusal", undefined],
    [{ error: { code: "additional_challenge_required" } }, "additional_challenge_required", undefined],
    [{ error: { status: 429 } }, "quota_or_rate_limited", 429],
    [{ error: { code: "rate_limit_exceeded" } }, "quota_or_rate_limited", undefined],
    [{ error: { status: 503 } }, "upstream_stream_error", 503],
    [{ error: { code: "service_unavailable" } }, "upstream_stream_error", undefined],
    [{ error: { code: "unknown_policy" } }, "unclassified_stream_error", undefined],
    [{ error: { status: 500, code: "unknown_policy" } }, "unclassified_stream_error", 500],
    [{ error: { code: "401" } }, "auth_rejected", 401],
    [{ error: { status: 429, code: "model_refusal" } }, "model_refusal", 429],
    [{ error: { status: 500, code: "authentication_error" } }, "auth_rejected", 500],
    [{ error: { code: "x".repeat(1000), message: "private upstream text" } }, "unclassified_stream_error", undefined],
  ])("classifies stream errors before permitting fallback (case %#)", async (error, category, status) => {
    serve(event(snapshot()) + event(error));
    const result = await run();
    expect(result).toMatchObject({ ok: false, error: { category, ...(status === undefined ? {} : { status }) } });
    expect(JSON.stringify(result)).not.toContain("private upstream text");
  });

  it.each([
    { channel: "analysis" },
    { channel: "commentary" },
    { author: { role: "tool" } },
    { metadata: { model_slug: "gpt-6", is_visually_hidden_from_conversation: true } },
  ])("tracks invisible message identities so unidentified patches cannot contaminate old final text (case %#)", async extra => {
    serve(event(snapshot("Visible", "a")) + event(snapshot("Hidden", "b", extra))
      + event({ p: "/message/content/parts/0", o: "append", v: " reasoning" }, "delta") + "data: [DONE]\n\n");
    const result = await run();
    expect(result).toMatchObject({ ok: false, error: { category: "invalid_output" } });
    expect(JSON.stringify(result)).not.toContain("reasoning");
  });

  it("reconstructs omitted-operation deltas and lists using the current content pointer", async () => {
    serve(event(snapshot("", "a", { status: "in_progress" }))
      + event({ p: "/message/content/parts/0", o: "append", v: "Hello" }, "delta")
      + event({ v: " world" }, "delta")
      + event({ p: "", v: "!" }, "delta")
      + event({ p: "", v: [
        { p: "/message/content/parts/0", o: "truncate", v: 11 },
        { p: "/message/status", o: "replace", v: "finished_successfully" },
      ] }, "delta") + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: true, content: "Hello world" });
  });

  it("accepts an explicitly final metadata channel when the top-level channel is absent", async () => {
    serve(event(snapshot("Visible", "a", { channel: undefined, metadata: { channel: "final", model_slug: "gpt-6" } })));
    expect(await run()).toMatchObject({ ok: true, content: "Visible" });
  });

  it("accepts the observed v1 marker and metadata object append without losing the model", async () => {
    serve(event("v1") + event(snapshot("", "a", { status: "in_progress" }))
      + event({ p: "", o: "patch", v: [
        { p: "/message/content/parts/0", o: "append", v: "Visible fixture" },
        { p: "/message/status", o: "replace", v: "finished_successfully" },
        { p: "/message/fixture_flag", o: "replace", v: true },
        { p: "/message/metadata", o: "append", v: { finish_details: { type: "stop" } } },
      ] }, "delta") + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: true, content: "Visible fixture", model: "gpt-6" });
  });

  it("accepts metadata append completion without a finished status", async () => {
    serve(event(snapshot("Visible", "a", { status: "in_progress" }))
      + event({ p: "/message/metadata", o: "append", v: { finish_details: { type: "stop" } } }, "delta")
      + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: true, content: "Visible", model: "gpt-6" });
  });

  it("rejects message object append that could inherit old completion and model", async () => {
    serve(event(snapshot("Old", "a"))
      + event({ p: "/message", o: "append", v: {
        id: "b", content: { content_type: "text", parts: ["New unfinished answer"] },
      } }, "delta") + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: false, error: { category: "malformed_sse" } });
  });

  it.each(["v2", "unknown"])("rejects an unknown string encoding marker (case %#)", async marker => {
    serve(event(marker) + event(snapshot()));
    expect(await run()).toMatchObject({ ok: false, error: { category: "malformed_sse" } });
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects prototype keys inside appended metadata objects (case %#)", async key => {
    const malicious: unknown = JSON.parse(`{"finish_details":{"${key}":{"fixture_polluted":true}},"model_slug":"gpt-6"}`);
    serve(event(snapshot("Visible", "a", { status: "in_progress" }))
      + event({ p: "/message/metadata", o: "append", v: malicious }, "delta") + "data: [DONE]\n\n");
    expect(await run()).toMatchObject({ ok: false, error: { category: "malformed_sse" } });
    expect((Object.prototype as Record<string, unknown>).fixture_polluted).toBeUndefined();
  });
});

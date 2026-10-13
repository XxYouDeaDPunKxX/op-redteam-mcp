import { findSecretLikeValue } from "../contracts/secrets";

export interface GptTransportTrace {
  modelsGet: number; requirementsPost: number; conversationPost: number;
  sseEvents: number; sseBytes: number; streamComplete: boolean;
}
export type GptTransportResult =
  | { ok: true; content: string; model: string; trace: GptTransportTrace }
  | { ok: false; error: { category: string; status?: number }; trace: GptTransportTrace };

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
class Failure extends Error {
  constructor(readonly category: string, readonly status?: number) { super(category); }
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Failure("aborted");
  let cancel = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new Failure("aborted"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([pending, stopped]); }
  finally { signal.removeEventListener("abort", cancel); }
}
async function readJson(response: Response, signal: AbortSignal, category: string): Promise<unknown> {
  if (!response.body) throw new Failure(category);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new Failure(category);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new Failure(category); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function required(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(required);
  if (!obj(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    ((key === "required" || key.endsWith("_required")) && item === true) || required(item));
}

function guardObjectKeys(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) guardObjectKeys(item); return; }
  if (!obj(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Failure("malformed_sse");
    guardObjectKeys(item);
  }
}

// Reconstruct one current message with the protocol's JSON pointer operations.
function patch(root: Obj, delta: unknown, observe: () => void, cursor: { path: string }): void {
  if (!obj(delta)) throw new Failure("malformed_sse");
  const op = delta.o ?? delta.operation ?? delta.op ?? "append";
  const suppliedPath = delta.p ?? delta.path;
  const path = suppliedPath === "" || suppliedPath === undefined ? cursor.path : suppliedPath;
  const value = delta.v ?? delta.value;
  if (Array.isArray(value) && (op === "patch" || value.every(item => obj(item) && ("p" in item || "path" in item || "o" in item || "operation" in item)))) {
    for (const item of value) patch(root, item, observe, cursor);
    return;
  }
  if (typeof path !== "string" || !path.startsWith("/")) throw new Failure("malformed_sse");
  cursor.path = path;
  const keys = path.slice(1).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.some(k => ["__proto__", "constructor", "prototype"].includes(k))) throw new Failure("malformed_sse");
  let parent: Obj | unknown[] = root;
  for (const key of keys.slice(0, -1)) {
    const next: unknown = (parent as Obj)[key];
    if (!obj(next) && !Array.isArray(next)) throw new Failure("malformed_sse");
    parent = next;
  }
  const key = keys.at(-1)!;
  const current = (parent as Obj)[key];
  if (path === "/message/id" && current !== value && obj(root.message)) {
    delete root.message.status;
    root.message.content = { content_type: "text", parts: [""] };
    root.message.metadata = {};
  }
  if (op === "replace" || op === "add") (parent as Obj)[key] = value;
  else if (op === "append" && typeof current === "string" && typeof value === "string") (parent as Obj)[key] = current + value;
  else if (op === "append" && Array.isArray(current)) current.push(...(Array.isArray(value) ? value : [value]));
  else if (op === "append" && path === "/message/metadata" && obj(current) && obj(value)) {
    guardObjectKeys(value);
    Object.assign(current, value);
  }
  else if (op === "truncate" && typeof value === "number" && Number.isInteger(value) && value >= 0 && (typeof current === "string" || Array.isArray(current))) (parent as Obj)[key] = current.slice(0, value);
  else if (op === "remove") delete (parent as Obj)[key];
  else throw new Failure("malformed_sse");
  observe();
}
function visible(message: Obj): boolean {
  const channel = message.channel ?? (obj(message.metadata) ? message.metadata.channel : undefined);
  return obj(message.author) && message.author.role === "assistant" && channel === "final"
    && !(obj(message.metadata) && message.metadata.is_visually_hidden_from_conversation === true);
}

function streamFailure(event: Obj): Failure {
  const sources = obj(event.error) ? [event.error, event] : [event];
  const statuses: number[] = [];
  const codes: string[] = [];
  let unknownCode = false;
  const statusValue = (value: unknown): number | undefined => {
    const number = typeof value === "number" ? value
      : typeof value === "string" && /^[1-5]\d{2}$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined;
  };
  const readCode = (value: unknown) => {
    if (value === undefined || value === null || value === "error") return;
    const number = statusValue(value);
    if (number !== undefined) { statuses.push(number); return; }
    if (typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(value)) codes.push(value.toLowerCase());
    else unknownCode = true;
  };
  for (const source of sources) {
    for (const key of ["status", "status_code", "statusCode", "http_status"]) {
      const status = statusValue(source[key]);
      if (status !== undefined) statuses.push(status);
    }
    for (const key of ["code", "type", "category"]) readCode(source[key]);
  }
  if (typeof event.error === "string") readCode(event.error);
  const status = statuses[0];
  const has = (...values: string[]) => codes.some(code => values.includes(code));
  if (statuses.includes(401) || has("authentication_error", "auth_rejected", "invalid_authentication", "unauthorized", "invalid_api_key")) return new Failure("auth_rejected", status);
  if (statuses.includes(403) || has("security_barrier", "forbidden", "permission_denied", "access_denied")) return new Failure("security_barrier", status);
  if (has("model_refusal", "refusal", "content_filter", "content_policy_violation")) return new Failure("model_refusal", status);
  if (has("additional_challenge_required")) return new Failure("additional_challenge_required", status);
  const quotaCodes = ["quota_or_rate_limited", "rate_limit_exceeded", "rate_limit_error", "quota_exceeded", "insufficient_quota", "resource_exhausted"];
  const technicalCodes = ["internal_server_error", "server_error", "service_unavailable", "upstream_error", "request_timeout", "timeout", "overloaded_error", "temporarily_unavailable"];
  if (unknownCode || codes.some(code => !quotaCodes.includes(code) && !technicalCodes.includes(code))) return new Failure("unclassified_stream_error", status);
  if (statuses.includes(429) || has(...quotaCodes)) return new Failure("quota_or_rate_limited", status);
  if (statuses.some(value => value === 408 || value >= 500) || has(...technicalCodes)) return new Failure("upstream_stream_error", status);
  return new Failure("unclassified_stream_error", status);
}
async function readStream(response: Response, trace: GptTransportTrace, signal: AbortSignal): Promise<{ content: string; model: string }> {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) throw new Failure("stream_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", currentId: string | undefined, sticky: string | undefined;
  let tree: Obj = {}, eventComplete = false, done = false;
  const cursor = { path: "/message/content/parts/0" };
  const observe = () => {
    const message = tree.message;
    if (!obj(message) || !visible(message)) return;
    const metadata = obj(message.metadata) ? message.metadata : {};
    const content = obj(message.content) ? message.content : {};
    const text = content.content_type === "text" && Array.isArray(content.parts)
      ? content.parts.filter((part): part is string => typeof part === "string").join("") : "";
    if (findSecretLikeValue([text, metadata.model_slug, metadata.default_model_slug])) sticky = "secret_like_output";
    if (sticky !== "secret_like_output" && (content.content_type === "refusal" || metadata.refusal === true
      || typeof metadata.refusal === "string" || metadata.is_refusal === true
      || (obj(metadata.finish_details) && metadata.finish_details.type === "content_filter")
      || /^\s*I\s+(?:cannot\b|can['’]t\b|won['’]t\b|am\s+unable\b)/i.test(text))) sticky = "model_refusal";
  };
  const consume = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    trace.sseEvents++;
    if (data === "[DONE]") { done = true; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw new Failure("malformed_sse"); }
    if (parsed === "v1") return;
    if (!obj(parsed)) throw new Failure("malformed_sse");
    const name = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (parsed.type === "refusal" || name === "refusal") sticky ??= "model_refusal";
    if (parsed.type === "message_stream_complete" || name === "message_stream_complete") {
      if (currentId && (parsed.message_id === undefined || parsed.message_id === currentId)) eventComplete = true;
      return;
    }
    if (parsed.error !== undefined || parsed.type === "error" || name === "error"
      || (typeof parsed.type === "string" && ["authentication_error", "auth_rejected", "security_barrier", "model_refusal", "additional_challenge_required"].includes(parsed.type))) throw streamFailure(parsed);
    const envelope = obj(parsed.v) && obj(parsed.v.message) ? parsed.v : parsed;
    const message = envelope.message;
    if (obj(message)) {
      if (typeof message.id !== "string" || !message.id) throw new Failure("malformed_sse");
      if (message.id !== currentId) { currentId = message.id; eventComplete = false; cursor.path = "/message/content/parts/0"; }
      tree = { message }; observe(); return;
    }
    if (parsed.message_id !== undefined && parsed.message_id !== currentId) return;
    if (obj(parsed.delta) || typeof parsed.p === "string" || typeof parsed.path === "string" || (name === "delta" && "v" in parsed)) {
      if (!currentId) throw new Failure("malformed_sse");
      patch(tree, parsed.delta ?? parsed, observe, cursor);
      const next = tree.message;
      if (obj(next) && next.id !== currentId) {
        if (typeof next.id !== "string" || !next.id) throw new Failure("malformed_sse");
        currentId = next.id; eventComplete = false;
      }
      observe();
    }
  };
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      trace.sseBytes += part.value.byteLength;
      if (trace.sseBytes > 262144) throw new Failure("sse_size_limit");
      buffer += decoder.decode(part.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        consume(frame);
        if (done) break;
      }
      if (done) { buffer = ""; break; }
    }
    if (!done) buffer += decoder.decode();
    if (buffer.trim()) throw new Failure("truncated_response");
    if (sticky) throw new Failure(sticky);
    const message = tree.message;
    if (!obj(message)) throw new Failure("empty_response");
    const metadata = obj(message.metadata) ? message.metadata : {};
    const finish = metadata.finish_details;
    trace.streamComplete = eventComplete || message.status === "finished_successfully" || (obj(finish) && finish.type === "stop");
    if (!trace.streamComplete) throw new Failure("completion_unconfirmed");
    const content = message.content;
    if (!visible(message) || !obj(content) || content.content_type !== "text" || !Array.isArray(content.parts)
      || content.parts.some(part => typeof part !== "string")) throw new Failure("invalid_output");
    const text = content.parts.join("");
    if (!text.trim()) throw new Failure("empty_response");
    const model = metadata.model_slug ?? metadata.default_model_slug;
    if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model)) throw new Failure("model_unobserved");
    return { content: text, model };
  } catch (error) {
    if (sticky) throw new Failure(sticky);
    throw error;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function invokeGptAuto(token: string, deviceId: string, prompt: string, packet: unknown, signal: AbortSignal): Promise<GptTransportResult> {
  const trace: GptTransportTrace = { modelsGet: 0, requirementsPost: 0, conversationPost: 0, sseEvents: 0, sseBytes: 0, streamComplete: false };
  try {
    if (signal.aborted) throw new Failure("aborted");
    const request = async (path: string, method: "GET" | "POST", category: string, body?: unknown, extra?: Record<string, string>) => {
      const headers = new Headers({
        Authorization: `Bearer ${token}`, "OAI-Device-Id": deviceId,
        "User-Agent": "ChatGPT/1.2026.223 (Android 16; sdk_gphone64_arm64; build 2622307)",
        "OAI-Package-Name": "com.openai.chatgpt", "OAI-Client-Type": "android", "ChatGPT-Account-ID": "default",
        "ChatGPT-Residency-Region": "no_constraint", "X-OpenAI-Target-Path": path.split("?")[0]!,
        "Accept-Language": "en-US,en", "X-Device-Tier": "lower_mid",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...extra,
      });
      const response = await abortable(fetch("https://android.chat.openai.com" + path, {
        method, headers, redirect: "manual", signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = response.status;
        throw new Failure(status === 401 ? "auth_rejected" : status === 403 ? "security_barrier"
          : status === 429 ? "quota_or_rate_limited" : category, status);
      }
      return response;
    };
    trace.modelsGet++;
    const models = await readJson(await request("/backend-api/models?iim=false&supports_model_picker_upgrade_presets=true", "GET", "catalog_unavailable"), signal, "catalog_malformed");
    if (!obj(models) || !Array.isArray(models.models)) throw new Failure("catalog_malformed");
    trace.requirementsPost++;
    const requirements = await readJson(await request("/backend-api/sentinel/chat-requirements", "POST", "requirements_unavailable", {}), signal, "requirements_malformed");
    if (!obj(requirements)) throw new Failure("requirements_malformed");
    if (required(requirements)) throw new Failure("additional_challenge_required");
    if (typeof requirements.token !== "string" || !requirements.token) throw new Failure("requirements_token_missing");
    const session = crypto.randomUUID();
    const body = {
      action: "next", parent_message_id: crypto.randomUUID(), model: "auto", force_use_sse: true,
      force_use_search: false, force_use_tools: false, force_use_canvas: false, force_use_paragen: false,
      supported_encodings: ["v1"], supports_buffering: true,
      messages: [{ id: crypto.randomUUID(), author: { role: "user" }, content: { content_type: "text", parts: [prompt + "\n\n" + (typeof packet === "string" ? packet : JSON.stringify(packet))] },
        status: "finished_successfully", recipient: "all", metadata: { model_slug: "auto", default_model_slug: "auto", is_visually_hidden_from_conversation: false } }],
    };
    trace.conversationPost++;
    const response = await request("/backend-api/f/conversation", "POST", "conversation_rejected", body, {
      Accept: "text/event-stream", "Cache-Control": "no-cache", "oai-session-id": session,
      "x-oai-convo-session-id": session, "x-oai-turn-trace-id": crypto.randomUUID(),
      "openai-sentinel-chat-requirements-token": requirements.token,
    });
    return { ok: true, ...await readStream(response, trace, signal), trace };
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure(signal.aborted ? "aborted" : "network_error");
    return { ok: false, error: { category: failure.category, ...(failure.status === undefined ? {} : { status: failure.status }) }, trace };
  }
}

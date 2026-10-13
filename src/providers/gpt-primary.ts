import { findSecretLikeValue } from "../contracts/secrets";
import type { Env } from "../env";
import { invokeSparringModel, PROVIDER_DEADLINE_MS } from "../sparring/adapter";
import { modelMaterial, systemPrompt, type SparringInput, type SparringToolName } from "../sparring/request";
import type { ProviderAdapterOutcome } from "./common";
import { invokeGptAuto } from "./gpt-transport";

export interface ProviderMeta {
  selectedProvider: "chatgpt" | "native" | null;
  reportedModel?: string;
  gptConversationPosts: number;
  nativePosts: number;
  primaryFailure?: string;
  tokenRefreshed?: boolean;
}
type RoutedOutcome = ProviderAdapterOutcome & { providerMeta: ProviderMeta };
const RECOVERABLE = new Set([
  "deadline", "network_error", "provider_unavailable", "unexpected_redirect", "malformed_stream",
  "truncated_stream", "stream_too_large", "incomplete_stream", "empty_response", "invalid_model",
  "quota", "rate_limited", "provider_rate_limited", "invalid_model_output", "credential_unavailable",
  "aborted", "catalog_unavailable", "catalog_malformed", "requirements_unavailable", "requirements_malformed",
  "requirements_token_missing", "conversation_rejected", "stream_missing", "truncated_response", "completion_unconfirmed",
  "model_unobserved", "invalid_output", "upstream_stream_error", "malformed_sse", "sse_size_limit", "quota_or_rate_limited",
]);
class Deadline extends Error {}
async function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Deadline();
  let listener: () => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Deadline());
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([run(), deadline]); }
  finally { signal.removeEventListener("abort", listener); }
}

/** One account attempt and, only on a recoverable failure, one original native attempt. */
export async function invokeGptPrimary(
  env: Env, tool: SparringToolName, input: SparringInput, affinity: string,
  inspect: (content: string) => { accepted?: string; diagnostic?: string },
): Promise<RoutedOutcome> {
  const started = Date.now();
  const meta: ProviderMeta = { selectedProvider: null, gptConversationPosts: 0, nativePosts: 0 };
  const total = new AbortController();
  const primary = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), PROVIDER_DEADLINE_MS);
  const primaryTimer = setTimeout(() => primary.abort(), 45_000);
  const abortPrimary = () => primary.abort();
  total.signal.addEventListener("abort", abortPrimary, { once: true });
  const failure = (category: string): RoutedOutcome => ({ kind: "failure", category, status: "critic_failed", phase: "runtime", latencyMs: Math.max(0, Date.now() - started), providerMeta: meta });
  try {
    let category = "credential_unavailable";
    let failClosed = false;
    try {
      const account = env.GPT_ACCOUNT;
      if (account) {
        const stub = account.get(account.idFromName("chatgpt-primary"));
        const response = await bounded(() => stub.fetch("https://gpt-account/token", { method: "POST", signal: primary.signal }), primary.signal);
        if (response.status === 401 || response.status === 403) { category = "provider_authentication"; failClosed = true; }
        else if (response.ok) {
          const credentials: unknown = await bounded(() => response.json(), primary.signal);
          if (credentials && typeof credentials === "object" && "accessToken" in credentials && "deviceId" in credentials
            && typeof credentials.accessToken === "string" && credentials.accessToken.trim()
            && typeof credentials.deviceId === "string" && credentials.deviceId.trim()) {
            meta.tokenRefreshed = "refreshed" in credentials && credentials.refreshed === true;
            // Transport resolves on abort after retaining any observed secret or refusal.
            // Racing it against abort here would discard that safety observation.
            const result = await invokeGptAuto(credentials.accessToken as string, credentials.deviceId as string, systemPrompt(tool), modelMaterial(tool, input), primary.signal);
            meta.gptConversationPosts = result.trace?.conversationPost ?? 0;
            if (result.ok) {
              if (findSecretLikeValue(result.content)) { category = "secret_like_output"; failClosed = true; }
              else {
                const checked = inspect(result.content);
                if (checked.accepted !== undefined) {
                  meta.selectedProvider = "chatgpt";
                  if (typeof result.model === "string") meta.reportedModel = result.model;
                  return { kind: "candidate", content: result.content, latencyMs: Math.max(0, Date.now() - started), providerMeta: meta };
                }
                category = "invalid_model_output";
              }
            } else {
              category = result.error.category;
              failClosed = result.error.status === 401 || result.error.status === 403 || !RECOVERABLE.has(category);
            }
          }
        }
      }
    } catch (error) {
      category = error instanceof Deadline ? "deadline" : "credential_unavailable";
    } finally { clearTimeout(primaryTimer); }
    meta.primaryFailure = category;
    if (failClosed || !RECOVERABLE.has(category)) return failure(category);
    let posts = 0;
    const nativeFetch: typeof fetch = (url, init) => {
      if (++posts > 1 || total.signal.aborted) return Promise.reject(new Deadline());
      meta.nativePosts = posts;
      // Invoke fetch synchronously so a rejected or thrown request still consumes the sole attempt.
      return fetch(url, { ...init, signal: AbortSignal.any([total.signal, ...(init?.signal ? [init.signal] : [])]) });
    };
    meta.selectedProvider = "native";
    const native = await bounded(() => invokeSparringModel(env, tool, input, affinity, Date.now, nativeFetch), total.signal);
    return { ...native, latencyMs: Math.max(0, Date.now() - started), providerMeta: meta };
  } catch (error) {
    return failure(error instanceof Deadline ? "deadline" : "provider_unavailable");
  } finally {
    clearTimeout(primaryTimer); clearTimeout(totalTimer);
    total.signal.removeEventListener("abort", abortPrimary);
  }
}

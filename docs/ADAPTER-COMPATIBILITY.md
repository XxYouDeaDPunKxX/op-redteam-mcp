# Adapter compatibility

This repository has more than one provider shape. The active Worker routes are
the source of truth; the canary files are evidence-only tests and are skipped
unless explicitly enabled.

## Active runtime adapters

| Adapter | Transport shape | Active operations | Evidence |
| --- | --- | --- | --- |
| NVIDIA | OpenAI-style Chat Completions over HTTPS | `stress_structure`, `adversarial_review`, `sparring_pressure`, `sparring_scan`, `redteam_experiment` | `src/sparring/adapter.ts`, `src/sparring/request.ts` |
| OpenRouter | OpenAI-style Chat Completions over HTTPS | `premortem_trace`, `premortem_scan`, `abuse_path` | `src/sparring/adapter.ts`, `src/sparring/request.ts` |
| ChatGPT account session (opt-in) | Account-authenticated transport; reported model identifier is transport metadata | All eight tools when enabled; recoverable account-route failure can trigger one direct NVIDIA/OpenRouter attempt | ChatGPT setup guide and account adapter source |
| Cloudflare Workers AI | Native `env.AI.run()` binding; not an OpenAI HTTP adapter | `cloudflare_rollback` profile; `sparring_scan` is unsupported | `src/sparring/adapter.ts` |

The NVIDIA and OpenRouter adapters use different endpoints, model routes and
request parameters. They currently share response-envelope validation, usage
parsing and error classification. A shared response parser does not make their
models or request settings interchangeable.

The optional ChatGPT route uses a signed-in account session, not an OpenAI API
key. Its model identifier is reported by the upstream transport and is not a
physical-model guarantee. Each MCP call gets one account-route attempt.
Recoverable account-route failures, such as transport errors, invalid or
truncated output, quota, or timeout, can trigger one direct attempt on the
configured NVIDIA or OpenRouter route. Authentication
failures (including HTTP 401 or 403), security findings, model refusals, and
secret-like output end without fallback. There is no second ChatGPT attempt in
that MCP call. See the
[ChatGPT setup guide](CHATGPT-SETUP.md) for account setup, privacy boundaries,
and known limits.

Select Workers AI explicitly with `COGNITIVE_RUNTIME_PROFILE=cloudflare_rollback`.
Local `AUTH_MODE=none` also defaults to rollback when no recognized profile is
supplied. The local example file sets `COGNITIVE_RUNTIME_PROFILE=external`
to select NVIDIA/OpenRouter.

## Canary-only compatibility evidence

These providers are not active runtime routes in this repository:

| Provider | Transport shape | Evidence | Status |
| --- | --- | --- | --- |
| Groq | OpenAI-style Chat Completions | `test/groq-adversarial-canary.test.ts` | Skipped unless `RUN_GROQ_CANARY=1` |
| Mistral | OpenAI-style Chat Completions | `test/mistral-github-fast-canary.test.ts` | Skipped unless `RUN_NEW_FREE_ROUTES_CANARY=1` |
| GitHub Models | OpenAI-style Chat Completions | `test/mistral-github-fast-canary.test.ts` | Skipped unless `RUN_NEW_FREE_ROUTES_CANARY=1` |
| Cohere | Provider-native `/v2/chat` envelope | `test/cohere-adversarial-canary.test.ts` | Skipped unless `RUN_COHERE_CANARY=1` |

Gemini has no active adapter or canary in the current source and is not a
supported runtime route.

## What “compatible” means here

Compatibility means that the adapter builds the provider-specific request,
normalizes the response into the shared `ProviderAdapterOutcome`, classifies
bounded failure modes, and preserves the tool contract. It does not mean that
any provider accepting an OpenAI-shaped request can be substituted without
testing its model names, reasoning parameters, usage envelope, and error
format.

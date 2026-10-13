# Model and adapter evidence

This document records which provider adapters and models are configured for
OP Adversarial Pressure MCP, which tools use them, and what evidence is
currently available.

Three kinds of information are kept separate:

- **Runtime configuration** describes the routes and settings in the current
  source. It does not establish live provider availability or model quality.
- **Canary configuration** describes runnable, opt-in tests. A test definition
  does not establish that a run took place or what its outcome was.
- **Dated evaluation summaries** record observed outcomes and semantic triage
  for specific runs. They are not assertions made by the current test files or
  global model rankings.

## Current runtime routes

| Provider / adapter | Model | Tools or profile | Status | Evidence |
| --- | --- | --- | --- | --- |
| NVIDIA direct | `nvidia/nemotron-3-ultra-550b-a55b` | `stress_structure`, `redteam_experiment`, `adversarial_review` | Active runtime | `src/sparring/request.ts`, `src/sparring/adapter.ts`, `test/sparring.test.ts` |
| NVIDIA direct | `nvidia/nemotron-3-super-120b-a12b` | `sparring_pressure`, `sparring_scan` | Active runtime | `src/sparring/request.ts`, `src/sparring/adapter.ts`, `test/sparring.test.ts` |
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | `abuse_path`, `premortem_trace`, `premortem_scan` | Active runtime | `src/sparring/request.ts`, `src/sparring/adapter.ts`, `test/sparring.test.ts` |
| ChatGPT account session | Identifier reported by the account transport | All eight tools when `COGNITIVE_GPT_PRIMARY_ENABLED=true`; recoverable account-route failure can trigger one direct configured NVIDIA/OpenRouter attempt | Opt-in runtime route; reported identifier does not guarantee a physical model | Account adapter source and tests; see bounded evidence below |
| Cloudflare Workers AI rollback | `@cf/openai/gpt-oss-120b` | `cloudflare_rollback` profile; `sparring_scan` is not supported by this profile | Active rollback path | `src/sparring/request.ts`, `src/sparring/adapter.ts`, `test/sparring.test.ts`, `test/integration.test.ts` |

Local `AUTH_MODE=none` defaults to the rollback profile when no recognized
`COGNITIVE_RUNTIME_PROFILE` is supplied. The local example file explicitly
selects `external` for the NVIDIA/OpenRouter routes.

The ChatGPT account route is disabled by default and is selected explicitly
with `COGNITIVE_GPT_PRIMARY_ENABLED=true`. It uses the same tool-specific
prompts and validators. A tool call makes at most one account-route attempt.
Recoverable account-route failures, such as transport errors, invalid or
truncated output, quota, or timeout, can trigger one direct NVIDIA/OpenRouter
attempt. Authentication failures (including HTTP 401
or 403), security findings, model refusals, and secret-like output end without
fallback. There is no account-route retry within that MCP call. See the
[ChatGPT setup guide](CHATGPT-SETUP.md).

## Active runtime settings

The following values are taken from the current request builders. They
describe what the Worker sends; they are not claims about live provider
quality.

### NVIDIA direct

Transport: OpenAI-style Chat Completions over HTTPS at the NVIDIA integration
endpoint. The adapter sends `stream: false`, `top_p: 0.95`, and
`chat_template_kwargs.enable_thinking: true` for every active NVIDIA route.

| Tool | Model | Temperature | Max tokens | Additional setting |
| --- | --- | ---: | ---: | --- |
| `stress_structure` | `nvidia/nemotron-3-ultra-550b-a55b` | `1` | `4096` | Thinking enabled |
| `sparring_pressure` | `nvidia/nemotron-3-super-120b-a12b` | `1` | `4096` | Thinking enabled; `low_effort: true` |
| `sparring_scan` | `nvidia/nemotron-3-super-120b-a12b` | `0.7` | `8192` | Thinking enabled |
| `redteam_experiment` | `nvidia/nemotron-3-ultra-550b-a55b` | `1` | `8192` | Thinking enabled |
| `adversarial_review` | `nvidia/nemotron-3-ultra-550b-a55b` | `1` | `8192` | Thinking enabled |

### OpenRouter

Transport: OpenAI-style Chat Completions over HTTPS at the OpenRouter
endpoint. All three routes use `temperature: 0`,
`reasoning: { effort: "high", exclude: true }`, and `stream: false`.

| Tool | Model | Max tokens |
| --- | --- | ---: |
| `abuse_path` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `4096` |
| `premortem_trace` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `4096` |
| `premortem_scan` | `nvidia/nemotron-3-ultra-550b-a55b:free` | `8192` |

### Cloudflare Workers AI rollback

Transport: native `env.AI.run()`; this is not an OpenAI-compatible HTTP
adapter. The model is `@cf/openai/gpt-oss-120b`, with
`reasoning: { effort: "high" }` and `store: false`.

The output ceiling is `8192` for `redteam_experiment`,
`adversarial_review`, and `premortem_scan`; it is `4096` for the other
rollback requests. The runtime does not execute `sparring_scan` in this
profile and returns a provider-configuration failure for it.

### ChatGPT account session

This optional route uses a signed-in account session through an
account-authenticated transport. It is not an OpenAI API key endpoint or a
public API availability guarantee. The model identifier comes from the
transport and does not establish the physical model that handled a request.
The server validates the response with each tool's existing validator. A
recoverable account-route failure, such as a transport error, invalid or
truncated output, quota, or timeout, can be followed by one direct call on the
tool's configured NVIDIA or OpenRouter route.
Authentication failures (including HTTP 401 or 403), security findings, model
refusals, and secret-like output fail closed without fallback.

Historical bounded evidence: a Free-account sign-in completed, credentials
were renewed, and one tool call completed in a prior private evaluation. That
observation is not a reproducible public test artifact or a current deployment
certification. It does not establish general quality, reliability, quota,
pricing, or terms compatibility. Plus and Pro accounts were not verified live.

On 2026-10-13, a private Cloudflare preview importing this public source
completed one `stress_structure` call with a Free account. Its response passed
the existing output validator: one ChatGPT conversation request and zero native
fallback requests. The preview used an already configured credential owner;
this does not verify a fresh deployment's initial login. The private proof is
not included in this repository. Automated tests
exercise all eight routes, direct fallback, encrypted credential storage, and
renewal using synthetic fixtures. These are bounded checks, not a quality or
availability certification.

## Canary configurations

These are optional provider probes, not runtime routes. They are
skipped by default and require private provider credentials. Before enabling a
canary, set `CANARY_OUTPUT_DIR` to an existing absolute directory outside this
checkout; the tests fail closed when it is missing or points inside the
checkout, because the result can contain raw provider material.

| Provider | Models | Configured calls | Test definition |
| --- | --- | --- | --- |
| Groq | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`, `qwen/qwen3-32b` | Seven targeted tool calls | `test/groq-adversarial-canary.test.ts` |
| Cohere | `command-a-reasoning-08-2025`, `command-a-plus-05-2026`, `command-r-plus-08-2024` | Four targeted tool calls | `test/cohere-adversarial-canary.test.ts` |
| Mistral | `magistral-small-latest` | `premortem_trace` | `test/mistral-github-fast-canary.test.ts` |
| GitHub Models | `microsoft/phi-4-reasoning`, `deepseek/deepseek-r1-0528` | `stress_structure`, `adversarial_review` | `test/mistral-github-fast-canary.test.ts` |

The settings below describe the current canary definitions. The dated summaries
under each provider describe historical runs, not a fresh execution of those
definitions.

Each probe records results and checks the number of completed calls. A passing
test run does not assert that every response passed its output checks or
semantic triage. Inspect each recorded result before drawing a conclusion.

### Groq

Configuration source: `test/groq-adversarial-canary.test.ts`.

Common settings are `top_p: 0.95`, `max_completion_tokens: 4096`,
`reasoning_format: "hidden"`, `stream: false`, and a 150-second request
timeout. The test does not retry rejected requests and spaces repeated calls
to the same model by 20 seconds.

| Model | Tool | Reasoning effort | Temperature |
| --- | --- | --- | ---: |
| `openai/gpt-oss-120b` | `adversarial_review` | `high` | `0.6` |
| `openai/gpt-oss-120b` | `redteam_experiment` | `high` | `0.6` |
| `openai/gpt-oss-20b` | `stress_structure` | `high` | `0.6` |
| `openai/gpt-oss-20b` | `sparring_pressure` | `high` | `0.6` |
| `qwen/qwen3.6-27b` | `premortem_trace` | `default` | `1.0` |
| `qwen/qwen3.6-27b` | `premortem_scan` | `default` | `1.0` |
| `qwen/qwen3-32b` | `abuse_path` | `default` | `0.6` |

`shape_valid` requires HTTP success, string output and the tool-specific
output checks. The test records finish state and token usage but does not
validate them or include them in `shape_valid`.

#### Groq evaluation summary — 2026-07-18

The run produced seven calls: four HTTP 200
responses and three HTTP 429 responses caused by the provider's free-plan TPM
limit. The bounded semantic observations were:

- `openai/gpt-oss-120b`: `adversarial_review` passed; `redteam_experiment`
  was inconclusive because of rate limiting.
- `openai/gpt-oss-20b`: `stress_structure` returned an accepted abstention
  that failed semantic triage; `sparring_pressure` was rate-limited.
- `qwen/qwen3.6-27b`: `premortem_trace` passed; `premortem_scan` was
  rate-limited.
- `qwen/qwen3-32b`: `abuse_path` found the weakness but failed the exact
  three-segment contract.

The run used `top_p: 0.95`, `max_completion_tokens: 4096`, and
`reasoning_format: "hidden"`. Its repeated calls were not spaced by the
20-second delay now present in the test; that delay was added after the
rate-limit responses. Those three calls remain inconclusive, not model-quality
failures.

### Cohere

Configuration source: `test/cohere-adversarial-canary.test.ts`.

Transport is the provider-native `/v2/chat` envelope. Common settings are
`max_tokens: 4096`, `temperature: 0.3`, `p: 0.9`, and a 150-second request
timeout. The request explicitly enables thinking for
`command-a-reasoning-08-2025`. For the other models it omits the field;
omission does not establish whether the provider enables thinking by default.

| Model | Tool | Thinking |
| --- | --- | --- |
| `command-a-reasoning-08-2025` | `premortem_trace` | Enabled |
| `command-a-reasoning-08-2025` | `adversarial_review` | Enabled |
| `command-a-plus-05-2026` | `redteam_experiment` | Field omitted |
| `command-r-plus-08-2024` | `abuse_path` | Field omitted |

`shape_valid` requires HTTP success, `finish_reason: COMPLETE`, and the
tool-specific output checks. The test records this result without requiring
all four calls to pass it.

#### Cohere evaluation summary — 2026-07-18

All four calls returned HTTP 200. The run used a 4,096-token ceiling,
temperature 0.3, and p 0.9, with thinking enabled for
`command-a-reasoning-08-2025`. The bounded semantic
observations were:

- `command-a-reasoning-08-2025`: `adversarial_review` passed;
  `premortem_trace` was structurally invalid because it retained forbidden
  square-bracket placeholder syntax.
- `command-a-plus-05-2026`: `redteam_experiment` produced a valid shape but
  introduced an admin-console observation outside the allowed action set.
- `command-r-plus-08-2024`: `abuse_path` passed the deterministic validator
  but restated the control and protected outcome instead of defeating them.

### Mistral and GitHub Models

Configuration source: `test/mistral-github-fast-canary.test.ts`.

Common settings are `temperature: 0.3`, `top_p: 0.95`, `max_tokens: 2048`,
`stream: false`, and a 90-second request timeout. The test makes no retry or
fallback call.

| Provider | Model | Tool |
| --- | --- | --- |
| Mistral | `magistral-small-latest` | `premortem_trace` |
| GitHub Models | `microsoft/phi-4-reasoning` | `stress_structure` |
| GitHub Models | `deepseek/deepseek-r1-0528` | `adversarial_review` |

`shape_valid` requires HTTP success, string output and the tool-specific
output checks. Finish state and available token counts are recorded, not
validated, and do not contribute to `shape_valid`.

#### Mistral and GitHub Models evaluation summary — 2026-07-18

The recorded observations were:

- Mistral returned a non-JSON `Model service is unavailable` response after
  about 50 seconds.
- GitHub `microsoft/phi-4-reasoning` returned HTTP 200 after about 47 seconds,
  but exhausted the 2,048-token ceiling with `finish_reason: length` and did
  not produce the required final contract.
- GitHub `deepseek/deepseek-r1-0528` returned HTTP 500 with a non-JSON
  `Model service is unavailable` response.

The Mistral observation is a reported inference failure, not a completed
output-validation result. The GitHub observations include captured HTTP and
finish-state results. Neither service unavailability nor truncation at this
token ceiling establishes a general model-quality verdict.

## What is and is not known

### Verified from source and tests

- The exact active model identifiers and tool routing.
- The request settings listed above.
- The transport family and provider endpoint class for each adapter.
- The output-envelope validation used by the runtime and canaries.
- Which canary tests are opt-in and which credentials they require.

### Not verified from the current evidence set

- Live quality, latency, cost, or reliability ranking between models.
- Generalizing a bounded result to other tools, prompts, providers, or dates.
- A reason for not promoting a model beyond the exact tool/canary conditions
  recorded in the bounded evaluation notes.

The bounded results are evidence for these exact runs. They are not a complete
benchmark and do not justify a global model ranking.

## Recording future results

When an opt-in canary is run, retain a redacted result record outside the
public guide unless its contents are explicitly safe to publish. The
record should preserve at least:

```json
{
  "generated_at": "2026-10-07T00:00:00.000Z",
  "provider": "provider-name",
  "model": "exact/model-id",
  "tool": "tool_name",
  "source_revision": "local-source-or-commit-identifier",
  "settings": {
    "temperature": 0.3,
    "max_tokens": 2048,
    "reasoning": "provider-specific"
  },
  "http_status": 200,
  "finish_reason": "stop",
  "latency_ms": 1234,
  "shape_valid": true,
  "decision": "retain | investigate | reject",
  "decision_basis": "short evidence-based explanation"
}
```

Do not store provider keys, raw authorization headers, private endpoints, or
unredacted sensitive prompts in a public result record. A future rejection
entry should cite the result record and state whether the reason was request
compatibility, envelope incompatibility, invalid output shape, truncation,
latency, cost, or another explicitly observed condition.

## Source map

- Runtime model constants and request settings:
  `src/sparring/request.ts`
- Runtime routing, endpoints, deadlines, and envelope handling:
  `src/sparring/adapter.ts`
- Active routing assertions:
  `test/sparring.test.ts`
- Groq canary:
  `test/groq-adversarial-canary.test.ts`
- Cohere canary:
  `test/cohere-adversarial-canary.test.ts`
- Mistral and GitHub Models canary:
  `test/mistral-github-fast-canary.test.ts`
- Transport-level overview:
  `docs/ADAPTER-COMPATIBILITY.md`

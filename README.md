![OP Adversarial MCP banner](assets/Immagine%20ChatGPT%209%20ott%202026%2C%2020_32_25.png)

# OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges

Bounded structural stress, sparring, premortem, and abuse-path tests on one target. GPT calls one tool, triages its candidate, then develops only surviving signal; no auto-retry or decisions.

This MCP lets your AI assistant ask another model to challenge an idea, plan, or line of reasoning while you work together. It adds a focused check at a useful moment: test an assumption, explore how a plan could fail, examine a document's structure, or propose an experiment.

A plausible explanation can still rest on a weak connection. The project separates generating criticism from judging its value: the model behind a tool proposes a challenge, and your assistant decides what the evidence supports and what is useful for the task. The eight tools cover everyday planning, product ideas, procedures, and technical work, as well as security questions.

MCP, the Model Context Protocol, is how an assistant connects to these tools. You continue the conversation in your usual assistant. The assistant selects a tool, supplies the relevant context, and evaluates the response. Your MCP host connects the assistant to the server; the model provider supplies the review behind each tool.

[Configure your deployment and connect an assistant](docs/GETTING-STARTED.md). Local developer checks are covered separately in the technical section below.

## How it fits into a conversation

1. You discuss a task with your assistant: develop an idea, work through a plan, or examine something you have written.
2. The assistant identifies a useful point to test, chooses one tool, and prepares enough context for that check.
3. The tool sends that context to its configured model. The model behind the tool generates a challenge, possible failure path, structural review, or proposed experiment.
4. The assistant checks the candidate against the supplied material and available evidence. It can use a supported result, develop an interpretation with explicit limits on what that evidence supports, or discard it.
5. The assistant continues the task with you, explaining what the check supports and what remains uncertain.

A check can be useful while an idea is taking shape, when a dependency becomes clear, or as a plan changes. Further checks can occur at different moments in the same conversation, one at a time. Each check is bounded to one MCP tool call. An enabled provider fallback stays within that call.

This is the intended workflow when the client and assistant follow the server and tool instructions. Connecting the server alone does not guarantee that the assistant will invoke it. You keep decisions and authorization; a returned proposal does not authorize action.

The [short personal instruction](docs/ASSISTANT-INSTRUCTIONS.md) tells your assistant to initiate useful checks during critical tasks and major pivots.

## Eight ways to examine the work

Some tools examine a precise point the assistant has already identified. Others let the model behind the tool look for a relevant weakness within the supplied material.

| Tool | What it contributes |
| --- | --- |
| `stress_structure` | Challenges one explicit claim that a particular part of a document or plan leads to a stated outcome. The assistant has already isolated that connection. |
| `sparring_pressure` | Pressures an early idea at a point and from an angle the assistant has selected, exploring a hypothetical change and its effect on the intended outcome. |
| `sparring_scan` | Starts with an early idea and its exact intended outcome. The model behind the tool selects one mechanism the idea depends on and explores pressure on it while preserving the idea. |
| `premortem_trace` | Traces how a failure condition already stated in a plan could lead to a specified outcome failing. |
| `premortem_scan` | Assumes a named outcome failed, then explores one possible initiating cause and path through the plan. The assistant does not preselect the cause. |
| `abuse_path` | Explores a hypothetical path from supplied access, through a stated control, to harm to the outcome that control protects. It neither executes an attack nor searches for threats elsewhere. |
| `adversarial_review` | Examines one supplied document or other artifact for structural weaknesses and the smallest structural fixes. It focuses on how the material works, rather than polishing style. |
| `redteam_experiment` | Proposes one experiment with an observable result that could show the target failed, using only explicitly allowed actions and observations. It never runs the experiment. |

## An everyday example

Suppose you are discussing a shared shopping-list app. Your idea removes an item from the list when a receipt contains its name, even if only part of the requested quantity was bought.

While helping develop the idea, the assistant could ask `adversarial_review` to examine that removal rule. An illustrative response might point out that buying one carton could clear a request for three, and propose retaining the unpurchased quantity.

The assistant would compare that criticism with the rule you supplied. The quantity mismatch follows from the stated behavior, so it has a basis for discussing a change with you. A claim that the app also misidentifies shoppers would need its own support; the assistant should discard that separate claim if the supplied material says nothing about shopper identification. It then continues developing the idea with the supported concern and its limits clear.

This is an illustration, not a recorded run. A task need not use several tools.

## What a check can establish

The model behind the tool proposes; the calling assistant checks whether the supplied material or available evidence supports the result and whether it is relevant and useful. A useful result may still need a stated limit. The assistant must not invent missing context or patch together discarded reasoning to rescue a result.

The model behind the tool works from the context supplied for that call. It does not search for missing facts. Hypotheses can help expose a dependency or suggest a test, but they are not evidence that an event occurred.

Finding a flaw is not a requirement for every check. For example, `stress_structure` is instructed to report when the supplied material supports no direct challenge. That is a valid result, not a reason to invent a problem.

Either model can be wrong. Passing the server's checks does not prove a candidate correct, and finding no useful criticism does not prove the original material correct. The tools do not make your decisions or execute the actions they describe.

## Run it in your own accounts

The included cloud route uses a Worker in your own Cloudflare account, GitHub sign-in to control access, and accounts with model providers, the services through which the tools access their models. GitHub handles authentication here; NVIDIA is configured for five tools and OpenRouter for three. You do not need a home server or GPU. Inference runs through cloud services, so this route is not local or offline.

Installing and connecting the server is a separate job from everyday conversation. Your assistant's app must support the server's remote MCP connection and its sign-in flow. The project is not tied to one assistant app; support depends on those capabilities, and no universal client compatibility is claimed. The app hosting your assistant and the provider handling an MCP model call are separate parts of the setup.

For the model behind the tools, the recommended personal configuration uses your own ChatGPT Free account as primary for all eight tools, with direct NVIDIA/OpenRouter fallback for recoverable failures. A separate ChatGPT account keeps the new conversation created by each model request out of your main account's chat list. This account advice is optional. The template leaves the ChatGPT provider disabled until you enable it; NVIDIA/OpenRouter can also run alone. Follow the [ChatGPT provider setup guide](docs/CHATGPT-SETUP.md).

Free service allowances may let you evaluate it without additional service charges when your accounts, workload, and access terms qualify. NVIDIA's hosted free access is for prototyping and testing; check the applicable terms before ongoing or production use. Hosting, provider usage, and any assistant subscription remain separate costs. See the [NVIDIA access FAQ](https://docs.api.nvidia.com/nim/docs/product) and the compact cost notes below.

## Context and privacy

Each call sends the context the assistant supplies to the configured provider. Use material you are permitted to share with that service, and keep credentials out of tool inputs.

An optional external log collector is disabled by default. If enabled, it receives tool requests and responses, which may contain private material. Cloudflare operational metrics are separate and are not disabled by that switch. The technical section explains both.

Follow [Getting started](docs/GETTING-STARTED.md) to configure the Worker and connect your assistant.

<details>
<summary>Technical setup, model routes, logging, and maintainer reference</summary>

## Local development and checks

This is a TypeScript Cloudflare Worker with Streamable HTTP MCP at `/mcp`. The repository pins Node.js `24.14.0` and npm `11.9.0` in [package.json](package.json). From the project directory:

```sh
node --version
npm --version
npm ci
npm run check
```

`check` runs type checking, tests, and a dry-run build. `npm run build` creates `dist/` without deployment. [CI](.github/workflows/ci.yml) uses the same check command with live-provider canaries disabled; ordinary tests leave them disabled too. On Windows, use `npm.cmd` and `npx.cmd` if PowerShell blocks the script wrappers.

For an unauthenticated local development server:

```sh
npm run dev -- --ip 127.0.0.1 --port 8787
```

Keep it on loopback; do not expose this mode through a tunnel or public interface. Use `http://localhost:8787/mcp` for requests because the development command sets `localhost` as the expected origin. Listing tools needs no provider key; NVIDIA and OpenRouter model calls require their respective provider API keys.

[The developer guide](docs/DEVELOPER-CHECKS.md) covers listing tools and making a first call. For external model calls, local `.dev.vars` needs `COGNITIVE_RUNTIME_PROFILE=external`, `IDENTITY_HMAC_KEY`, and the relevant provider key. See [.dev.vars.example](.dev.vars.example); keep real secrets out of the repository. Without a recognized profile, local `AUTH_MODE=none` defaults to the Workers AI rollback route.

## Remote deployment and authentication

Use [the deployment guide](docs/GETTING-STARTED.md) in a separate unpublished deployment copy. It covers Cloudflare resources, GitHub OAuth, secrets, and the publishing command. The checked-in [wrangler.jsonc](wrangler.jsonc) is a template.

The client must support Streamable HTTP, OAuth authorization code with PKCE S256, resource indicators, and dynamic registration as a public client with `token_endpoint_auth_method=none`. The scope is `review:invoke`. Registration accepts one exact allowlisted callback per client.

| Setting | Required value |
| --- | --- |
| `AUTH_MODE` | `github` for remote access |
| `PUBLIC_ORIGIN` and `MCP_RESOURCE` | Identical HTTPS Worker origin, without a path or trailing slash |
| Client's server URL | Worker origin followed by `/mcp` |
| GitHub OAuth App callback | Worker origin followed by `/callback` |
| `ALLOWED_GITHUB_USER_IDS` | Allowed numeric GitHub user IDs |
| `ALLOWED_DCR_REDIRECT_URIS` | Exact client callback URLs, separate from the GitHub callback |
| `COGNITIVE_RUNTIME_PROFILE` | `external` for the included staging configuration |

Staging requires `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `IDENTITY_HMAC_KEY`, `OPENROUTER_API_KEY`, and `NVIDIA_API_KEY` as Worker secrets, plus a real `OAUTH_KV` namespace.

```sh
npm run preflight:staging
npm run build:staging
```

The preflight fails closed on the untouched placeholders, empty allowlists, and all-zero KV ID. It reads `wrangler.jsonc` for `staging`; the staging build runs it before the dry-run build. Neither command deploys or verifies live credentials, resource existence, or client sign-in. The environment name `staging` does not make a later deployment temporary or free.

## Configured models and adapters

These are source-configured routes, not a live availability or quality guarantee.

| Provider/profile | Model | Tools |
| --- | --- | --- |
| NVIDIA direct | `nvidia/nemotron-3-ultra-550b-a55b` | `stress_structure`, `adversarial_review`, `redteam_experiment` |
| NVIDIA direct | `nvidia/nemotron-3-super-120b-a12b` | `sparring_pressure`, `sparring_scan` |
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | `premortem_trace`, `premortem_scan`, `abuse_path` |
| Optional ChatGPT account route | Model reported by the upstream transport | All eight tools when enabled; direct NVIDIA/OpenRouter fallback for recoverable account-route failures |
| Cloudflare Workers AI, `cloudflare_rollback` | `@cf/openai/gpt-oss-120b` | All tools except `sparring_scan` |

The ChatGPT route is opt-in and uses a signed-in account session; it is not an OpenAI API key route or an upstream public API guarantee. The reported model name comes from the transport and does not prove which physical model served a request. Recoverable account-route failures such as transport errors, invalid or truncated output, quota, or timeouts permit one direct attempt using the configured NVIDIA or OpenRouter route. Authentication failures (including HTTP 401 or 403), security findings, model refusals, and secret-like output end without fallback. There is no ChatGPT retry within the same MCP call. NVIDIA and OpenRouter use provider-specific Chat Completions requests over HTTPS. Workers AI uses the native `env.AI.run()` binding. Select rollback explicitly with `COGNITIVE_RUNTIME_PROFILE=cloudflare_rollback`; it is not an automatic fallback and does not provide all eight tools.

Groq, Cohere, Mistral, and GitHub Models have opt-in canary tests only. They are not active runtime routes. Shared request or response shapes do not make providers interchangeable by changing an API key. [Adapter compatibility](docs/ADAPTER-COMPATIBILITY.md) and [model evidence](docs/MODEL-ADAPTER-EVIDENCE.md) document settings, historical observations, and their limits.

The native routes have a 150-second provider deadline. With ChatGPT primary enabled, credential retrieval or renewal and the ChatGPT request share a 45-second cutoff; any permitted native fallback must finish within the shared 150-second provider budget. The configured Worker limit is six calls per 60 seconds per derived identity. Inputs and outputs undergo bounded validation and secret screening; these checks do not establish semantic correctness. Exact schemas come from `tools/list` and [src/server.ts](src/server.ts).

## Cost conditions

Pricing snapshot checked 2026-10-07. Free allocations can support evaluation, but this exact deployment has not been certified to fit every free-plan limit.

- ☁️ [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) includes 100,000 requests/day and 10 ms CPU per invocation. Low request volume alone does not establish CPU compatibility. Workers Paid has a $5/month minimum.
- 🗄️ [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) has separate free operation/storage limits. [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) lists allocations and currently says usage is not yet billed; check current conditions for both.
- 🧠 [NVIDIA's hosted free access](https://docs.api.nvidia.com/nim/docs/product) is offered for prototyping. Its [API trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) restrict production use of trial services and generated content. Check the terms applicable to your use.
- 🔀 [OpenRouter Free](https://openrouter.ai/pricing/) lists 50 requests/day. The configured `:free` model route remains subject to availability and provider limits.

Your assistant's subscription or API charges are separate. Account eligibility, runtime resource use, provider terms, and quotas determine actual cost; no permanent or universal zero-cost operation is promised.

## Optional generic telemetry log sink

The sink is off unless `LOG_SINK_ENABLED=true`. It sends JSON by HTTPS POST to `LOG_SINK_URL`, authenticated with `Authorization: Bearer <LOG_SINK_TOKEN>`. The collector must return a 2xx response.

For local development, configure these values in the ignored `.dev.vars` file, then restart the server:

```dotenv
LOG_SINK_ENABLED=true
LOG_SINK_URL=https://your-collector.example/ingest
LOG_SINK_TOKEN=replace-with-your-collector-token
```

Events include a schema version, event ID, time, source, hashed subject identifier, tool, runtime version, outcome, provider/total latency, available token usage, and the tool request and response. Treat those last two fields as potentially private. Secret screening is not comprehensive redaction; calls rejected by the input secret check are not sent to the sink.

Delivery runs in the background with a three-second timeout and no retry. Sink failure does not change the tool response; a successful MCP call therefore does not prove delivery. Delivery failures emit a separate metric.

For a deployed Worker, follow [the optional sink procedure](docs/LOG-SINK.md). It stores the token as a secret and enables logging with an explicit deployment override. Keep the template's disabled baseline for preflight. Disabling delivery does not delete previously collected events.

## Operational metrics and maintainer checks

Cloudflare Analytics Engine is separate from the external sink. Tool metrics include a request ID, hashed subject identifier, tool, outcome, version, diagnostic, latency, and available token counts; these metric fields do not contain tool input or response text. OAuth cleanup and sink-delivery failures also emit metrics. Turning the sink off does not turn these metrics off.

For focused development checks:

```sh
npm run typecheck
npm run test
npm run test:tools
npm run build
```

Live-provider canaries require deliberate opt-in and private provider credentials. Set `CANARY_OUTPUT_DIR` to an absolute, existing directory OUTSIDE the checkout before enabling one; results may contain raw provider material. The canaries fail closed when that boundary is not satisfied. Ordinary tests do not enable them. A passing canary test does not mean every recorded response is semantically usable; inspect its results using [the evidence guide](docs/MODEL-ADAPTER-EVIDENCE.md#canary-configurations).

## Source and documentation

| Reference | What to find |
| --- | --- |
| [Getting started](docs/GETTING-STARTED.md) | Installation, remote deployment, connection, and use during tasks |
| [Developer checks](docs/DEVELOPER-CHECKS.md) | Local tool discovery and synthetic protocol requests |
| [Log sink setup](docs/LOG-SINK.md) | Optional collector configuration and deployment |
| [Optional ChatGPT provider setup](docs/CHATGPT-SETUP.md) | Backend account sign-in, opt-in configuration, and route limits |
| [Optional assistant instructions](docs/ASSISTANT-INSTRUCTIONS.md) | Host-independent guidance for selecting and evaluating a check |
| [Adapter compatibility](docs/ADAPTER-COMPATIBILITY.md) | Runtime routes versus canary-only adapters |
| [Model and adapter evidence](docs/MODEL-ADAPTER-EVIDENCE.md) | Request settings and bounded evaluation records |
| [Server](src/server.ts) and [prompts](src/prompts/) | Tool schemas, assistant instructions, provider prompts |
| [Worker entry point](src/index.ts) | Routing and authentication |
| [Requests](src/sparring/request.ts), [adapter](src/sparring/adapter.ts), and [service](src/sparring/service.ts) | Model requests, routing, and output checks |
| [Tests](test/) | Runtime, authentication, boundary, and optional canary checks |
| [Log sink](src/log-sink.ts) and [telemetry](src/telemetry.ts) | External event delivery and operational metrics |
| [Security policy](SECURITY.md) | Private vulnerability reporting |

</details>

## AI-assisted development

This project was developed with AI assistance.

The project, documentation, and repository materials were shaped through human-directed work supported by AI tools during drafting, structuring, review, and refinement.

AI assistance does not make the project automatically correct, complete, or suitable for every use case. Read it, test it, and adapt it to your own context.

## License

MIT. See [LICENSE](LICENSE).

The ChatGPT account sign-in dependency is distributed under Apache-2.0; its
license and attribution are preserved in [third-party notices](THIRD-PARTY-NOTICES.md).

# Optional ChatGPT model provider

This guide configures ChatGPT as the model provider behind all eight tools in
OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges. Your calling assistant can run in any host that
supports the server's remote MCP transport and authentication flow. Choosing
ChatGPT as the provider is separate from choosing that host.

The Worker uses a signed-in account and requests automatic model selection
from ChatGPT's conversation service. A recognized recoverable failure can
trigger one direct attempt on the tool's configured NVIDIA or OpenRouter
route. Both attempts stay inside the same MCP tool call.

## Before you start

Complete the regular [remote deployment](GETTING-STARTED.md)
first. You need the deployed Worker, its Durable Object migration, and the
normal NVIDIA and OpenRouter fallback credentials. This account route runs in
your Cloudflare Worker; it does not run the model on your computer.

The recommended personal provider configuration uses a ChatGPT Free account
with NVIDIA/OpenRouter fallback. A separate account keeps the new conversation
created by each model request out of your main account's chat list. This is
account advice; the Worker does not require a separate account or restrict
login to the Free plan. Plus and Pro use the same login path. Upstream access
and limits depend on the account and service.
Check [OpenAI's applicable service terms](https://openai.com/policies/terms-of-use/)
and account limits before use.

The commands below authorize the backend account used for model reviews.
Your MCP host connects to the Worker separately, using GitHub sign-in and the
`review:invoke` scope. Follow [Connect your assistant](GETTING-STARTED.md)
for that connection, regardless of the selected model provider.

## Enable the route

In the deployment copy of the project, set this staging variable to `true`:

```jsonc
"COGNITIVE_GPT_PRIMARY_ENABLED": "true"
```

The example belongs beside the other entries in `env.staging.vars` in
`wrangler.jsonc`. Set it to `true` for the recommended personal setup. Leave
it `false` to keep NVIDIA/OpenRouter as the primary route. The source and
configuration templates default to disabled until you choose the route. Keep
`COGNITIVE_RUNTIME_PROFILE` set to `external` and retain both provider keys so
the direct fallback is available.

The staging Durable Object binding must use class `GptAccount`, and its SQLite
migration must include tag `chatgpt-account-v1`. The project deployment
template includes these declarations. Keep the standard `COOKIE_ENCRYPTION_KEY`
and `IDENTITY_HMAC_KEY` secrets configured as described in the deployment
guide. The account session and pending PKCE state are encrypted in the bound
Cloudflare Durable Object; tool inputs are not stored there.

Deploy the updated Worker and migration using the regular deployment steps.
This creates or updates a real Cloudflare resource and may have service costs.
The helper starts a temporary gated Worker preview for setup. When the command
ends, it closes local listeners, stops Wrangler, and removes the generated
local preview files. The preview gate expires after 15 minutes. The deployed
MCP Worker exposes no permanent account-administration route.

## Sign in and check the account

From the deployment copy, sign in to the intended Cloudflare account with
Wrangler if needed, then run:

```sh
npx wrangler login
npm run chatgpt:login -- --env staging
```

The command starts a temporary private preview connection on a random local
port to your deployed Worker's Durable Object, then opens a browser sign-in
page. If it does not open, copy the displayed sign-in link into your browser.
The browser returns to a temporary listener on `localhost:1455`. Complete
sign-in in the browser and wait for the command to confirm completion. The
helper forwards the authorization code and state through the gated preview.
The `GptAccount` Durable Object checks the saved state, exchanges the code
using the saved PKCE verifier, then stores the credentials encrypted. Tokens
are not written as plaintext files or printed in command output. The temporary
preview and listener close when the command completes.

The OAuth dependency handles sign-in and token renewal. Model requests use
ChatGPT's conversation service.

The callback listener needs local port `1455`. If sign-in cannot start because
that port is already in use, close the application using it and run the login
command again.

To check only account/session metadata, run:

```sh
npm run chatgpt:status -- --env staging
```

Status reports whether credentials are present and their expiry information.
It does not print access or refresh tokens. All three commands use the
Cloudflare authentication already configured in Wrangler.

## Renewing access

The Worker renews credentials during a model request when the access token is
within 60 seconds of expiry. Renewal has a 20-second OAuth deadline. To request
renewal manually while the saved refresh credentials remain valid, run:

```sh
npm run chatgpt:renew -- --env staging
```

If sign-in is revoked or the provider no longer accepts the saved credentials,
repeat `chatgpt:login`. If a command reports a Worker, Durable Object, or
Cloudflare authentication error, check that the migration was deployed, that
Wrangler is signed into the intended account, and that the selected
environment is `staging` before retrying.

## What happens on a tool call

When enabled, each of the eight tools first makes one ChatGPT account-route
attempt using its existing tool-specific prompt and output validator. A
recoverable account-route failure, such as a transport error, invalid or
truncated output, quota, or timeout, can trigger one direct attempt using the
tool's configured NVIDIA or OpenRouter route. There is no second ChatGPT
attempt in that MCP call. Authentication failures
(including HTTP 401 or 403), security findings, model refusals, and
secret-like output end the call without fallback. If the permitted attempts
fail, the tool returns its bounded failure response. All tools keep the same
input schemas, prompts, and validators.

Credential retrieval or renewal and the ChatGPT request share a 45-second
primary deadline. Any permitted native fallback must finish within the shared
150-second provider budget. The service selects the model automatically;
the reported model identifier is metadata from that service. Each tool's
normal output checks still apply.

## Calling-assistant instructions

Use the [optional calling-assistant instructions](ASSISTANT-INSTRUCTIONS.md)
through your MCP host's instruction settings. They apply independently of the
model provider configured in the Worker. The server and selected tool define
the complete handling rules.

## Privacy and known limits

Each request to the ChatGPT account route opens a fresh conversation in the
account used for the model route. The Worker does not fetch prior conversations
or change account memory settings. Memory and personalization settings remain
under your control in ChatGPT.

Use only information you are allowed to send to the account provider. The
request context is sent to the selected model service. Do not put passwords,
API keys, OAuth codes, or private account details in a tool input. Session
tokens are stored encrypted in your Cloudflare Durable Object. The setup
commands report metadata and do not reveal token values.

The account transport uses account-authenticated ChatGPT endpoints rather
than a supported public API. Their protocol, account limits, and model routing
can change. See [model and adapter evidence](MODEL-ADAPTER-EVIDENCE.md) for the
public source and synthetic-test coverage. That coverage does not establish
live account availability, model quality, or quota accounting.

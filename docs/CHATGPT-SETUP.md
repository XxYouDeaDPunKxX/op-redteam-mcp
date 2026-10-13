# Optional ChatGPT account route

This guide adds an optional account-based route for the model calls made by
OP Adversarial Pressure MCP. The regular setup uses NVIDIA for five tools and
OpenRouter for three. For a personal DIY setup, the recommended choice is a
Free ChatGPT account as primary, with the existing direct NVIDIA/OpenRouter
routes as fallback. ChatGPT can be selected as primary for all eight tools.
Recoverable account-route failures, such as transport errors, invalid or
truncated output, quota, or timeout, can trigger one direct fallback attempt.

This route is intended for personal evaluation. It uses a signed-in ChatGPT
account session, not an OpenAI API key or a public, supported API endpoint.
The upstream service reports the model identifier; that value does not prove
which physical model handled a request. A successful attempt may still be
rejected by the tool's normal output checks.

The OAuth dependency supplies sign-in and token renewal only. Model requests
use ChatGPT's conversation service; this Worker does not send inference
requests to Codex. Account quota accounting has not been independently measured.

## Before you start

Complete the regular [remote deployment](GETTING-STARTED.md#4-prepare-a-remote-deployment)
first. You need the deployed Worker, its Durable Object migration, and the
normal NVIDIA and OpenRouter fallback credentials. This account route runs in
your Cloudflare Worker; it does not run the model on your computer.

Use a free ChatGPT account for personal evaluation. A separate account is
recommended because every request to the ChatGPT model route opens a new
conversation, which can clutter the account's conversation list. This is
setup advice only; the project does not require or enforce a second account.
Plus or Pro accounts use the same login flow, but live testing covered a Free
account only. No plan-specific availability, cost, or quota guarantee is made.
Check [OpenAI's applicable service terms](https://openai.com/policies/terms-of-use/)
and account limits before use.

There are two separate sign-ins. The backend account used for model reviews is
authorized by the commands below. The MCP client is the assistant app that
connects to your Worker. If you want ChatGPT to be that client, custom MCP apps
must be available under your ChatGPT plan and workspace settings. Follow
OpenAI's current
[developer mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
and configure the server as a remote MCP app using your Worker URL ending in
`/mcp`. Complete the MCP OAuth sign-in when ChatGPT asks. Availability and
menus vary by plan and workspace. You can also use another compatible MCP
client as the caller.

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
Cloudflare Durable Object; model request packets are not stored there.

Deploy the updated Worker and migration using the regular deployment steps.
This creates or updates a real Cloudflare resource and may have service costs.
The login helper and its private preview are temporary: they exist only while
the command runs, then the helper and its temporary files are removed. Your
computer is not a permanent gateway, and the Worker has no permanent account
administration route.

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
within 60 seconds of expiry. Renewal has a 20-second OAuth deadline. You do
not need a weekly manual login schedule. To request renewal manually, for
example after an account recovery, run:

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

The primary setting only affects the server's model route. It does not cause
your calling assistant to invoke other MCP tools. The calling assistant should
choose at most one appropriate check at a consequential decision, major pivot,
or fragile assumption that could affect the outcome. It should read the tool
description, send one complete packet that satisfies the tool's rules, then
triage the complete response as `usable`, `usable_with_limits`, or `unusable`.
It should use supported points with their limits, discard unsupported points,
briefly say what it used or discarded, and not automatically retry or call
another tool to fill gaps. A returned challenge is a candidate, not a decision
for the user or a guarantee.

## Add these calling-assistant instructions

In ChatGPT on web or desktop, paste the block under **Settings →
Personalization → Custom Instructions**. On iOS or Android, use **Settings →
Customize ChatGPT**. Personal instructions apply across chats; the block names
OP Adversarial Pressure MCP and asks ChatGPT to apply its guidance only when
you use that connection. If you prefer to scope it to one place, paste it into a dedicated project's
**Project settings**. Start a chat in that project and select this MCP app
from the tools menu when it is available. See OpenAI's
[Custom Instructions guide](https://help.openai.com/en/articles/8096356-chat-preference-for-chatgpt)
and [Projects guide](https://help.openai.com/en/articles/10169521-projects-in-chatgpt).

```text
For OP Adversarial Pressure MCP only: When a task reaches a consequential decision, major pivot, or fragile assumption that could affect its outcome, consider whether one bounded adversarial check would help. If useful, read OP's tool descriptions and select one appropriate tool. Send one self-contained packet that meets that tool's rules and make one call. Treat the complete tool-defined response as one candidate unit; triage it as usable, usable_with_limits, or unusable. Integrate supported points with their limits; discard unsupported points. Briefly report what you used or discarded. Do not invent facts, split or repair a rejected unit, automatically retry, or cascade to another tool. A check is optional, not required for every answer. Leave decisions to the user.
```

These instructions guide the calling assistant. They do not guarantee that a
client will choose to invoke the server.

## Privacy and known limits

Each request to the ChatGPT account route opens a fresh conversation in the
account used for the model route. The project does not read or manage
conversation history, saved memories, or other account settings. Any memory
settings remain under your control in ChatGPT.

Use only information you are allowed to send to the account provider. The
request context is sent to the selected model service. Do not put passwords,
API keys, OAuth codes, or private account details in a tool input. Session
tokens are stored encrypted in your Cloudflare Durable Object. The setup
commands report metadata and do not reveal token values.

The account transport is not a public OpenAI API with a compatibility or
availability guarantee. Provider behavior, account limits, and model routing
can change. Historical Free-account evaluation and a dated preview check of
the public source are described in the evidence guide. They do not certify a
fresh deployment, quality, reliability, or service terms. Plus and Pro account behavior was not
verified live. See [model and adapter evidence](MODEL-ADAPTER-EVIDENCE.md) for
the project evidence and its limits.

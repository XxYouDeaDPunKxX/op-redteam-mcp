# Getting started

Connect this MCP to your assistant, then discuss your tasks as usual. The
assistant selects the tool, prepares the request, and evaluates the result
while working with you.

The host must support remote MCP over HTTPS and the server's OAuth flow.
The Worker runs in your Cloudflare account. NVIDIA/OpenRouter supply the
configured model calls; [ChatGPT can also be the model provider](CHATGPT-SETUP.md).
The model provider and the host running your assistant are separate choices.

The steps below cover installation, remote deployment, connection, and use.
[Local developer checks](DEVELOPER-CHECKS.md) are documented separately.

Use non-sensitive sample text for your first call. Tool inputs go to the
configured model provider; an enabled fallback may send the same material to
a second provider. Keep credentials out of task material. Usage may consume
provider quotas or incur charges.

## 1. Install and check the project

Install [Node.js 24.14.0](https://nodejs.org/en/blog/release/v24.14.0), which
includes npm 11.9.0. These are the versions required by `package.json`.

Download and extract the project, or clone it if you use Git. Open a terminal
in the folder containing `package.json`. On Windows, use PowerShell; on macOS
or Linux, use your terminal. Run these commands one at a time:

```sh
node --version
npm --version
npm ci
npm run check
```

The version commands should show `v24.14.0` and `11.9.0`. `npm ci` installs the
locked dependencies. `npm run check` runs type checking, tests and the dry-run
build, in that order. Optional live-provider tests are skipped by default;
leave them disabled during setup. The build creates `dist/` without publishing
anything to Cloudflare. The [GitHub CI workflow](../.github/workflows/ci.yml)
uses the same check command and explicitly disables live-provider tests.

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm`, and `npx.cmd`
instead of `npx` below. You do not need to change the execution policy.

## 2. Prepare a remote deployment

Remote access uses GitHub sign-in and explicit allowlists. You need a
Cloudflare account, a GitHub account, NVIDIA and OpenRouter keys, and an MCP
client that supports this server's authentication flow.

Before creating cloud resources, check your client's documentation for:

- Streamable HTTP transport for remote MCP servers.
- OAuth authorization-code sign-in with PKCE S256, a login-flow protection.
- Dynamic client registration (DCR) as a public client, with
  `token_endpoint_auth_method=none`.
- OAuth resource indicators: the authorization request must send `resource`
  equal to the Worker origin, without `/mcp` or a trailing slash. This tells
  the server which resource the client wants to access.
- The exact callback URL that the client uses to finish sign-in. A callback
  is the address the browser returns to after authorization.

The server accepts one callback URL per client registration, matched against
its allowlist, and exposes the scope `review:invoke`. If the client offers only
a local command/stdio connection, static API-key authentication, or a different
registration flow, this guide does not establish compatibility. See the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
for the protocol terminology.

### Keep deployment settings separate

Use a separate, unpublished local copy of the project for deployment. Keep
the shared template unchanged. Extract another copy into a folder such as
`op-redteam-mcp-deploy`, open a terminal there, and run `npm ci`.

All remaining deployment commands run from that folder. Edit its
`wrangler.jsonc`, under `env.staging`. Keep the top-level settings and the other
bindings unchanged. The preflight command reads this exact file; it does not
read an arbitrarily named local config file.

The environment is named `staging`, but deploying it creates a real hosted
Worker and may incur charges. With the unchanged project name, Cloudflare names
it `op-redteam-mcp-staging`. Its origin is `https://` plus the hostname, with
no path or trailing slash:

```text
https://op-redteam-mcp-staging.YOUR-SUBDOMAIN.workers.dev
```

Replace `YOUR-SUBDOMAIN` with your account's
[`workers.dev` subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
No custom domain is needed for this path.

### Sign in to Cloudflare and create storage

```sh
npx wrangler login
npx wrangler whoami
```

Confirm that Wrangler is using the Cloudflare account where you want the
Worker to run. If you have several accounts, select the account explicitly
with `CLOUDFLARE_ACCOUNT_ID` in this terminal. Do not add `account_id` to
`wrangler.jsonc`; the preflight rejects it.

PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "replace-with-your-account-id"
```

macOS/Linux:

```sh
export CLOUDFLARE_ACCOUNT_ID="replace-with-your-account-id"
```

The next command creates real Cloudflare storage for OAuth registrations and
tokens. Run it once for this deployment:

```sh
npx wrangler kv namespace create OAUTH_KV --env staging --update-config=false
```

Copy the returned namespace ID into `env.staging.kv_namespaces[0].id`, replacing
the all-zero value. Keep the binding name `OAUTH_KV`. See the
[Wrangler KV commands](https://developers.cloudflare.com/workers/wrangler/commands/kv/)
if you need to find an existing namespace instead of creating another one.

### Configure GitHub sign-in and both callbacks

Create a dedicated OAuth App in GitHub's Settings → Developer settings →
OAuth Apps. Follow [GitHub's creation instructions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
Give it a name you recognize, set its Homepage URL to your Worker origin, and
set its Authorization callback URL to that origin followed by `/callback`.
Save the app's Client ID and generate a Client Secret.

These are different addresses with different jobs:

| Setting | Value |
| --- | --- |
| `PUBLIC_ORIGIN` and `MCP_RESOURCE` | Your Worker origin, with no trailing slash or `/mcp` path. Both must be identical. |
| Server URL entered in your MCP client | Your Worker origin followed by `/mcp`. |
| Authorization callback URL in the GitHub OAuth App | Your Worker origin followed by `/callback`. |
| `ALLOWED_DCR_REDIRECT_URIS` | The exact callback URL supplied by your MCP client, not the Worker's `/callback`. |

For the GitHub user allowlist, open
`https://api.github.com/users/YOUR-GITHUB-USERNAME` in a browser after replacing
the username. Copy the numeric `id` field, not `login` or `node_id`.

In `env.staging.vars`, fill in:

- `PUBLIC_ORIGIN` and `MCP_RESOURCE` as shown above.
- `ALLOWED_GITHUB_USER_IDS` with your numeric GitHub user ID as a string.
- `ALLOWED_DCR_REDIRECT_URIS` with your client's exact callback URL.

For more than one allowed user or client callback, separate values with commas.
Do not use wildcards. Keep `AUTH_MODE` set to `github`,
`COGNITIVE_RUNTIME_PROFILE` set to `external`, and `LOG_SINK_ENABLED` set to
`false` for this setup.

The GitHub OAuth App credentials belong to the Worker. Do not enter them as
credentials for the MCP client. The Worker uses GitHub to check your identity
against its allowlist.

### Prepare the six Worker secrets

The staging configuration requires all six secrets below, including both
provider keys. Generate two independent random keys by running this command
twice, once for `COOKIE_ENCRYPTION_KEY` and once for `IDENTITY_HMAC_KEY`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Create `op-redteam-secrets.json` in the parent folder, outside the deployment
folder and outside any repository you share. Fill it with your own values:

```json
{
  "GITHUB_CLIENT_ID": "replace-with-the-oauth-app-client-id",
  "GITHUB_CLIENT_SECRET": "replace-with-the-oauth-app-client-secret",
  "COOKIE_ENCRYPTION_KEY": "replace-with-the-first-generated-key",
  "IDENTITY_HMAC_KEY": "replace-with-the-second-generated-key",
  "OPENROUTER_API_KEY": "replace-with-your-openrouter-api-key",
  "NVIDIA_API_KEY": "replace-with-your-nvidia-api-key"
}
```

This is a plaintext file containing credentials. Keep access limited to you,
store a recoverable copy in your password manager, and remove the plaintext
file after deployment when you no longer need it. Do not paste its contents
into issues, chats, or screenshots. `.dev.vars` is only for local development;
it does not provision deployed Worker secrets.

### Check, then deploy

Run the local checks first:

```sh
npm run preflight:staging
npm run build:staging
```

The untouched template fails preflight because it has placeholder URLs, empty
allowlists, and an all-zero KV ID. With those replaced, expect
`Staging preflight passed`. `build:staging` then builds without publishing.
These checks do not confirm that your credentials work, that the KV namespace
exists, or that the client can sign in.

The following command publishes to Cloudflare and uploads the secrets. Run it
only when you are ready to create or update the remote Worker:

```sh
npx wrangler deploy --env staging --secrets-file "../op-redteam-secrets.json"
```

Use `--secrets-file` for this first deployment: the pinned Wrangler version
cannot add the required secrets with `secret put` before this Worker exists.
See [Cloudflare's secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/).
Confirm that the deployed URL matches `PUBLIC_ORIGIN` exactly before connecting
a client. Preserve the same `--env staging` choice for later updates. This
deployment leaves the optional log sink disabled. To enable it later, use the
[optional sink procedure](LOG-SINK.md); its deployment flag must also
be included in subsequent updates that should keep logging enabled.

## 3. Connect your assistant

If your host asks for a name and description, copy these values.

Name:

```text
OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges
```

Description:

```text
Bounded structural stress, sparring, premortem, and abuse-path tests on one target. GPT calls one tool, triages its candidate, then develops only surviving signal; no auto-retry or decisions.
```

Add a remote MCP server in your client using your Worker's URL with `/mcp`.
Select OAuth sign-in if the client asks for an authentication method. It should
discover the authorization endpoints, register itself, and open the browser
sign-in flow. Approve the connection only if the displayed client is yours,
then sign in to the GitHub account whose numeric ID you allowed.

After authentication, ask your assistant to confirm that it can access the
connected MCP and its eight tools. The assistant handles discovery and calls.

Client screens and settings vary. A client that cannot complete registration
or send the `review:invoke` scope needs a compatibility check; do not disable
authentication or broaden the callback allowlist to make sign-in succeed.

For optional guidance on when your assistant should use a check, add the
[calling-assistant instructions](ASSISTANT-INSTRUCTIONS.md) through your host's
instruction settings. These apply to either model-provider configuration.

## 4. Use it during your task

Discuss your idea, plan, or document with your assistant as usual. During the
task, the assistant identifies a useful point for adversarial pressure,
selects the tool, prepares its input, and evaluates the returned candidate.
You provide the task and relevant material; the assistant constructs the MCP
request.

For a first connection check, you can send this synthetic example in chat:

> Use the connected adversarial MCP to check this idea: a shopping list removes an item when a receipt contains the same name, without checking quantity or recipient.

The assistant chooses the appropriate tool and prepares the call. It then
explains what it used or discarded and continues the task with you.

Add the [short personal instruction](ASSISTANT-INSTRUCTIONS.md) if you want
the assistant to initiate useful checks during tasks. The server and tool
instructions govern how it prepares and handles each check.

A returned challenge is a candidate. A `NO GROUNDED…` result means that no
supported candidate was produced for that check; it does not prove the
material correct.

## Optional logging

Follow the [log sink setup](LOG-SINK.md) if you want to send tool inputs and
responses to your own collector.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `npm ci` reports an engine mismatch | Check `node --version` and `npm --version` in the same terminal. Use the versions in section 1. |
| Connection refused on port 8787 | Keep the server terminal running and check its startup output. Another process may be using the port. |
| HTTP 421 | The request origin differs from `PUBLIC_ORIGIN`. Locally, use `http://localhost:8787/mcp`, not the IP address. Remotely, check the full deployed hostname. |
| HTTP 500 before sign-in | Check origin formatting, `AUTH_MODE`, required secrets, and Worker logs. The origin must have no trailing slash and must equal `MCP_RESOURCE`. |
| HTTP 401 from a remote `/mcp` request | Complete OAuth in the MCP client. An unauthenticated terminal request does not test the signed-in connection. |
| Registration or sign-in is rejected | Check the client's exact callback, your numeric GitHub ID, the GitHub OAuth App callback, and its Client ID/Secret. These are separate settings. |
| HTTP 400 before GitHub sign-in | Check that the client sends the OAuth `resource` parameter equal to `PUBLIC_ORIGIN`, without `/mcp` or a trailing slash. Also check PKCE and the requested scope. |
| Local tool call fails, but listing works | Check `.dev.vars`, `COGNITIVE_RUNTIME_PROFILE=external`, `IDENTITY_HMAC_KEY`, and the key for that tool's provider; restart the server. |
| `provider_configuration` diagnostic | Check the selected profile and provider credentials. |
| `provider_rate_limited` diagnostic | Check the provider's quota and limits. Decide whether to retry later; do not loop automatically. |
| `rate_limited` tool error | The Worker rate limit is configured at six requests per 60 seconds per derived identity. Pause before another operator-initiated attempt. |
| `secret_detected` tool error | Remove the credential-like material. Do not resend the same input. |
| `invalid_model_output` tool error | The provider response failed output checks. Treat the call as failed; a working connection does not guarantee a valid model answer. |
| Preflight passes, but deployment fails | Preflight checks local configuration only. Read Wrangler's error for account permissions, resource availability, or missing secrets. |

Use Issues for reproducible bugs and Discussions for setup questions. For a
suspected vulnerability, use the private reporting instructions in
[SECURITY.md](../SECURITY.md) instead of sharing details publicly.

When asking for help, include the command, runtime versions, and error code.
Redact credentials, tokens, user identifiers, and private input text. Do not
attach `.dev.vars` or the secrets file.

For optional logging, follow [the sink setup](LOG-SINK.md).
For model routes, settings, and the limits of historical tests, use
[adapter compatibility](ADAPTER-COMPATIBILITY.md) and
[model and adapter evidence](MODEL-ADAPTER-EVIDENCE.md).

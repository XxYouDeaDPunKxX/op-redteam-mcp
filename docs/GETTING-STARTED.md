# Getting started

OP Adversarial Pressure MCP asks a model to challenge an idea, plan, or document
you supply. It has eight tools, each with a specific kind of question. It does
not search for missing information or execute the actions it describes.

An MCP client is the app or assistant that calls these tools. The Worker
is the server in this repository, which runs locally for development or on
Cloudflare for remote access. Wrangler is Cloudflare's command-line tool;
this project installs its pinned version for you.

Choose how far you want to go:

- [Run locally](#1-install-and-check-the-project) and list the tools. No service
  accounts or API keys are needed for this check.
- [Make a model call](#3-make-a-first-model-call). This sends your input to an
  external provider and needs an API key.
- [Deploy and connect a client](#4-prepare-a-remote-deployment). This needs
  Cloudflare, GitHub, both provider keys, and a compatible MCP client.
- [Configure ChatGPT as an optional model provider](CHATGPT-SETUP.md). This
  authorizes a backend account separately from your MCP host's connection.
  The NVIDIA/OpenRouter-only configuration is also available.

Use non-sensitive sample text for your first call. Read-only tools still send
their input to the configured model provider. An enabled fallback may send the
same input to a second provider. Usage may incur charges or consume provider
quotas. Keep credentials out of tool inputs. The secret detector is not a
guarantee that all sensitive text will be caught.

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

## 2. Run locally and list the tools

Start the development server:

```sh
npm run dev -- --ip 127.0.0.1 --port 8787
```

Keep this terminal open. The command uses local development mode with no
authentication. Keep it bound to your own computer; do not expose it through
a tunnel or use this configuration for a public server.

In a second terminal, paste this single-line command:

```sh
node --input-type=module -e "const r=await fetch('http://localhost:8787/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}); console.log('HTTP',r.status); const data=await r.json(); console.log(data.result?.tools?.map(t=>t.name)??data);"
```

Expect `HTTP 200` and these eight names:

```text
stress_structure
sparring_pressure
premortem_trace
abuse_path
redteam_experiment
adversarial_review
premortem_scan
sparring_scan
```

This checks the server and its tool catalogue without calling a model. Use
`localhost` in the request even though the server is bound to `127.0.0.1`:
the development command configures `localhost` as the expected origin.
Opening the URL in a browser is not the same test; MCP uses protocol requests.

Press `Ctrl+C` in the server terminal when you want to stop it. You can stop
here if you only wanted to check that the project runs.

## 3. Make a first model call

For this example, get an API key with access to the configured NVIDIA models.
See [NVIDIA's API quickstart](https://docs.api.nvidia.com/nim/docs/api-quickstart).
The current routes and model identifiers are listed in
[model and adapter evidence](MODEL-ADAPTER-EVIDENCE.md).

Stop the local server. Generate a local identity key with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Create a text file named exactly `.dev.vars` next to `package.json`, with these
values. Replace both `replace-with-...` entries; do not leave the placeholders.
On Windows, check that your editor has not added a `.txt` extension.

```dotenv
COGNITIVE_RUNTIME_PROFILE=external
IDENTITY_HMAC_KEY=replace-with-the-generated-key
NVIDIA_API_KEY=replace-with-your-nvidia-api-key
LOG_SINK_ENABLED=false
```

`IDENTITY_HMAC_KEY` lets the server derive an identifier for rate limiting.
It is needed for tool calls even when the optional log sink is off.
`COGNITIVE_RUNTIME_PROFILE=external` selects the NVIDIA/OpenRouter routes.
Without it, unauthenticated local mode selects the Cloudflare Workers AI
rollback route, which is not the route used in this example.

`.dev.vars` is ignored by Git. Keep it local and do not include it in shared
archives. The larger [`.dev.vars.example`](../.dev.vars.example) also shows
authentication and logging variables; you do not need those for this local call.

Restart the server with the command from section 2. In the second terminal,
start Node's interactive prompt:

```sh
node
```

Paste the following JavaScript into that prompt. It makes one real request to
NVIDIA through the Worker. The shopping-list example is synthetic:

```js
(async () => {
  const call = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'adversarial_review',
      arguments: {
        artifact: 'A shopping list removes an item when a receipt contains the same name, without checking quantity or recipient.',
        review_request: 'Find flaws that could make this automatic removal unreliable.'
      }
    }
  };
  const reply = await fetch('http://localhost:8787/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(call)
  });
  console.log('HTTP', reply.status);
  console.log(JSON.stringify(await reply.json(), null, 2));
})();
```

Wait for the HTTP status and JSON response; Node may show `Promise { <pending> }`
first. Then type `.exit` to leave the prompt. A successful call returns text in
`result.content` and a review in `result.structuredContent.review`. There is no
fixed expected model answer. HTTP 200 alone is not enough: check for a top-level
`error` or `result.isError: true`, then use the troubleshooting section below.

Treat the review as a candidate to check against the supplied text. Discard
claims that rely on invented context. The service does not decide whether
your idea is safe or correct, and the default external route does not retry
automatically. The optional ChatGPT primary route has a bounded direct fallback;
see the [ChatGPT setup guide](CHATGPT-SETUP.md) for when it applies.

To use `premortem_trace`, `premortem_scan`, or `abuse_path`, also add
`OPENROUTER_API_KEY` to `.dev.vars` and restart the server. Get that key through
[OpenRouter](https://openrouter.ai/docs/quickstart). The other five tools use
NVIDIA in the external profile.

For the optional account-based ChatGPT route, follow the separate
[ChatGPT setup guide](CHATGPT-SETUP.md). The default external profile continues
to use NVIDIA and OpenRouter.

## 4. Prepare a remote deployment

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
[optional sink procedure](#optional-log-sink); its deployment flag must also
be included in subsequent updates that should keep logging enabled.

## 5. Connect your MCP client

Add a remote MCP server in your client using your Worker's URL with `/mcp`.
Select OAuth sign-in if the client asks for an authentication method. It should
discover the authorization endpoints, register itself, and open the browser
sign-in flow. Approve the connection only if the displayed client is yours,
then sign in to the GitHub account whose numeric ID you allowed.

After authentication, ask the client to list the tools. Expect the eight names
from section 2. Then ask it to call `adversarial_review` once, using the
`artifact` and `review_request` from section 3. Its tool input is those two
fields; the JSON-RPC envelope is handled by the client.

Client screens and settings vary. A client that cannot complete registration
or send the `review:invoke` scope needs a compatibility check; do not disable
authentication or broaden the callback allowlist to make sign-in succeed.

For optional guidance on when your assistant should use a check, add the
[calling-assistant instructions](ASSISTANT-INSTRUCTIONS.md) through your host's
instruction settings. These apply to either model-provider configuration.

## Optional log sink

The sink sends tool inputs and responses to an HTTPS collector you control.
Read [what it sends and how delivery works](../README.md#optional-generic-telemetry-log-sink)
before enabling it. The collector must accept JSON authenticated with a Bearer
token and return a 2xx response.

For local use, configure `.dev.vars` as described in the README. The commands
below are for an existing Worker deployed with section 4. Run them from your
unpublished deployment copy, using the same Cloudflare account.

In that copy's `wrangler.jsonc`, set `env.staging.vars.LOG_SINK_URL` to your
collector's actual HTTPS URL. Keep `LOG_SINK_ENABLED` set to `"false"` in the
file and keep the public template unchanged. The preflight requires this
disabled baseline; the `--var` flag below overrides only that value for the
selected deployment.

Check the baseline and build the enabled configuration without publishing:

```sh
npm run preflight:staging
npx wrangler deploy --dry-run --env staging --var LOG_SINK_ENABLED:true --outdir dist/staging
```

The preflight checks the file, not the command-line override. The dry-run
checks the build; neither check verifies the collector, its token or delivery.
See [Wrangler's deployment options](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
for `--var` and `--dry-run`.

The next two commands change the deployed Worker. Store the token at the
interactive prompt, then deploy with the sink enabled:

```sh
npx wrangler secret put LOG_SINK_TOKEN --env staging
npx wrangler deploy --env staging --var LOG_SINK_ENABLED:true
```

Never put the token in the command line or in `wrangler.jsonc`. The Worker
already has the six required secrets from the first deployment; these commands
do not replace them. Make one tool call with synthetic input and confirm that
the collector receives an event. A successful MCP response alone does not
prove delivery, because sink failures do not change that response.

Repeat `--var LOG_SINK_ENABLED:true` on later deployments that should keep the
sink enabled. A deployment without it reapplies the file's `"false"` value.
To disable the sink on the deployed Worker, run:

```sh
npx wrangler deploy --env staging
```

This stops sink delivery for new invocations handled by the updated Worker.
It does not delete events already stored by the collector or disable the
separate Cloudflare Analytics Engine metrics described in the README.

## Choose a tool

Supply all the context the tool needs in its input. For exact fields and
limits, use the schema returned by `tools/list`.

| When you have… | Use |
| --- | --- |
| A document to review, without an isolated target-to-outcome relation | `adversarial_review` |
| One explicit claim connecting a target to an outcome | `stress_structure` |
| An early idea, a selected target, an outcome, and a challenge lens | `sparring_pressure` |
| An early idea and its exact intended outcome, without a selected target | `sparring_scan` |
| A plan and a stated condition that could lead to a specified failure | `premortem_trace` |
| A plan and a failed outcome, without an isolated initiating condition | `premortem_scan` |
| An access point, a control, and an outcome to protect | `abuse_path` |
| A target plus explicit permitted actions and observations for a test | `redteam_experiment` |

`redteam_experiment` proposes a test; it does not run it. Check every returned
candidate against your input before acting on it. A `NO GROUNDED…` result
means the tool did not produce a supported candidate, not that it proved the
material correct.

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

For optional logging, follow [the sink setup](#optional-log-sink).
For model routes, settings, and the limits of historical tests, use
[adapter compatibility](ADAPTER-COMPATIBILITY.md) and
[model and adapter evidence](MODEL-ADAPTER-EVIDENCE.md).

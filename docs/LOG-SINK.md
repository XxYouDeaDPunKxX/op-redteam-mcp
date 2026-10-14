# Optional log sink

The log sink sends tool inputs and responses to an HTTPS collector you
control. It is disabled by default.

The sink is off unless `LOG_SINK_ENABLED=true`. It sends JSON by HTTPS POST to `LOG_SINK_URL`, authenticated with `Authorization: Bearer <LOG_SINK_TOKEN>`. The collector must return a 2xx response.

For local development, configure these values in the ignored `.dev.vars` file, then restart the server:

```dotenv
LOG_SINK_ENABLED=true
LOG_SINK_URL=https://your-collector.example/ingest
LOG_SINK_TOKEN=replace-with-your-collector-token
```

Events include a schema version, event ID, time, source, hashed subject identifier, tool, runtime version, outcome, provider/total latency, available token usage, and the tool request and response. Treat those last two fields as potentially private. Secret screening is not comprehensive redaction; calls rejected by the input secret check are not sent to the sink.

Delivery runs in the background with a three-second timeout and no retry. Sink failure does not change the tool response; a successful MCP call therefore does not prove delivery. Delivery failures emit a separate metric.

## Remote setup

The commands below are for an existing Worker deployed with
[Getting started](GETTING-STARTED.md). Run them from your
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
do not replace them. Ask your assistant to run one check with synthetic material, then confirm
that the collector receives an event. A successful MCP response alone does not
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

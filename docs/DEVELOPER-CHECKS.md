# Developer checks

These checks exercise the local Worker directly. They are for developers
working on the server or a client integration. Normal use happens through
your assistant after connecting the remote MCP. Install the dependencies
using [Getting started](GETTING-STARTED.md) first.

## 1. Run locally and list the tools

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

## 2. Send a synthetic model request

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

Restart the server with the command from section 1. In the second terminal,
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
`error` or `result.isError: true`, then use
[troubleshooting in Getting started](GETTING-STARTED.md).

This check exercises transport and output validation. In normal use, the
calling assistant evaluates the candidate against the supplied material. The service does not decide whether
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

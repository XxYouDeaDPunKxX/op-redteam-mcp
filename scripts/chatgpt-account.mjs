import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { unstable_readConfig } from "wrangler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callback = "http://localhost:1455/auth/callback";
class SetupError extends Error {}
export function setupErrorMessage(error) {
  return error instanceof SetupError ? error.message : "ChatGPT setup failed. Check configuration, Cloudflare login, and deployment; no credentials were printed.";
}
export function createPreviewConfig(config, scriptName, suffix = randomBytes(8).toString("hex")) {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(suffix)) throw new SetupError("Invalid temporary preview name.");
  const previewName = `op-mcp-auth-${suffix}`;
  if (previewName === scriptName) throw new SetupError("Temporary preview must differ from the deployed Worker.");
  return { name: previewName, main: "worker.js", compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags, workers_dev: false, preview_urls: false,
    ...(config.account_id ? { account_id: config.account_id } : {}),
    durable_objects: { bindings: [{ name: "GPT_ACCOUNT", class_name: "GptAccount", script_name: scriptName }] } };
}
const usage = `ChatGPT account setup (tokens stay in Cloudflare)
  npm run chatgpt:login  -- --env staging
  npm run chatgpt:status -- --env staging
  npm run chatgpt:renew  -- --env staging
Options: --config <wrangler.jsonc> --env <environment> --help
Deploy the configured Worker and authenticate Wrangler first. No provider tokens are printed.`;

export function parseOptions(args) {
  if (args.includes("--help")) return { help: true };
  const command = args[0];
  if (!["login", "status", "renew"].includes(command)) throw new SetupError("Choose login, status, or renew; use --help for usage.");
  const options = { command, env: "staging", config: "wrangler.jsonc" };
  for (let i = 1; i < args.length; i += 2) {
    if (!["--env", "--config"].includes(args[i]) || typeof args[i + 1] !== "string" || !args[i + 1] || args[i + 1].startsWith("--")) throw new SetupError("Invalid setup option; use --help.");
    options[args[i].slice(2)] = args[i + 1];
  }
  return options;
}
export function validateOperatorConfig(config) {
  const name = config.name;
  const vars = config.vars ?? {};
  const origin = vars.PUBLIC_ORIGIN;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,63}$/.test(name)) throw new SetupError("Configure a valid Worker name first.");
  let url;
  try { url = new URL(origin); } catch { throw new SetupError("Configure PUBLIC_ORIGIN before ChatGPT setup."); }
  if (url.protocol !== "https:" || url.origin !== origin || vars.MCP_RESOURCE !== origin || /YOUR-|\.invalid/i.test(origin)) throw new SetupError("Replace the public origin placeholders and matching MCP_RESOURCE first.");
  const binding = config.durable_objects?.bindings?.find(item => item.name === "GPT_ACCOUNT");
  if (!binding || binding.class_name !== "GptAccount" || binding.script_name) throw new SetupError("Deploy the local GPT_ACCOUNT / GptAccount binding first.");
  return name;
}
export function createPreviewSource(hash, expiresAt) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(expiresAt)) throw new SetupError("Invalid private preview gate.");
  return `const hash=${JSON.stringify(hash)},expiresAt=${expiresAt};
const routes=new Set(['/login/start','/login/complete','/status','/renew']);
export default {async fetch(request,env){
 if(Date.now()>expiresAt)return new Response(null,{status:410});
 const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
 if(!token||token.length>256)return new Response(null,{status:401});
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==hash)return new Response(null,{status:401});
 const pathname=new URL(request.url).pathname;
 if(request.method!=='POST'||!routes.has(pathname))return new Response(null,{status:404});
 const reader=request.body?.getReader();let chunks=[],size=0;
 if(reader){try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4096)return new Response(null,{status:413});chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const account=env.GPT_ACCOUNT.get(env.GPT_ACCOUNT.idFromName('chatgpt-primary'));
 return account.fetch('https://gpt-account'+pathname,{method:'POST',body:bytes});
}};`;
}
function safeMetadata(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SetupError("Unexpected account response.");
  const safe = {};
  for (const name of ["initialized", "needsRenewal", "refreshed", "accessTokenChanged", "refreshTokenChanged", "accountUnchanged", "deviceUnchanged"]) if (typeof body[name] === "boolean") safe[name] = body[name];
  for (const name of ["expiresAt", "beforeExpiresAt"]) if (Number.isSafeInteger(body[name])) safe[name] = body[name];
  if (typeof body.plan === "string" && /^[a-z0-9_-]{1,40}$/i.test(body.plan)) safe.plan = body.plan;
  if (!Object.keys(safe).length) throw new SetupError("Unexpected account metadata.");
  return safe;
}
async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise(resolve => { const stop = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); stop.once("error", resolve); stop.once("exit", resolve); });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
}
async function removeTemporary(directory) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("op-mcp-auth-")) throw new SetupError("Temporary cleanup boundary mismatch.");
  await rm(target, { recursive: true, force: true });
}
async function preview(config, signal) {
  const scriptName = validateOperatorConfig(config);
  const directory = await mkdtemp(path.join(tmpdir(), "op-mcp-auth-"));
  let gate = randomBytes(32).toString("base64url");
  let child;
  let closing;
  const close = () => closing ??= (async () => { gate = ""; try { await stopChild(child); } finally { await removeTemporary(directory); } })();
  try {
  const hash = createHash("sha256").update(gate).digest("hex");
  const port = await freePort();
  let inspector = await freePort();
  while (inspector === port) inspector = await freePort();
  const configPath = path.join(directory, "wrangler.json");
  await writeFile(path.join(directory, "worker.js"), createPreviewSource(hash, Date.now() + 15 * 60000));
  await writeFile(configPath, JSON.stringify(createPreviewConfig(config, scriptName), null, 2));
  if (signal.aborted) throw new SetupError("Setup cancelled.");
  child = spawn(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", configPath,
    "--remote", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--show-interactive-dev-session=false", "--log-level", "error"],
    { cwd: root, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  // Wrangler output never contains the gate, but keep its operational output out of credential setup logs.
  child.stdout.resume(); child.stderr.resume();
  let stopped = false;
  child.once("exit", () => { stopped = true; }); child.once("error", () => { stopped = true; });
  const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!ready && Date.now() < deadline && !stopped && !signal.aborted) {
      try { ready = (await fetch(base + "/status", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })).status === 401; } catch { /* wait for the private preview */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (signal.aborted) throw new SetupError("Setup cancelled.");
    if (!ready) throw new SetupError("Cloudflare preview did not start. Check Wrangler login and the deployed GptAccount binding.");
    return { close, async call(route, body = {}) {
      const response = await fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${gate}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) throw new SetupError(`Account operation failed (HTTP ${response.status}). Check the account setup or sign in again if access was revoked.`);
      return value;
    } };
  } catch (error) { await close(); throw error; }
}
function openBrowser(url) {
  const executable = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(executable, args, { windowsHide: true, stdio: "ignore" });
  child.once("error", () => { console.log("Open the authorization link above in your browser."); });
}
async function initialLogin(gateway, signal) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", () => reject(new SetupError("Cannot open localhost:1455. Close another OAuth callback listener and retry."))); server.listen(1455, "127.0.0.1", resolve); });
  try {
    const flow = await gateway.call("/login/start", { redirectUri: callback });
    const authorization = new URL(flow.authorizationUrl);
    if (authorization.origin !== "https://auth.openai.com" || authorization.pathname !== "/oauth/authorize" || typeof flow.state !== "string" || flow.state.length > 256) throw new SetupError("Unexpected authorization response.");
    await new Promise((resolve, reject) => {
      let busy = false;
      const timer = setTimeout(() => reject(new SetupError("Login expired. Run the login command again.")), 600000);
      const cancel = () => { clearTimeout(timer); reject(new SetupError("Setup cancelled.")); };
      signal.addEventListener("abort", cancel, { once: true });
      server.once("close", () => signal.removeEventListener("abort", cancel));
      if (signal.aborted) { cancel(); return; }
      server.on("request", async (request, response) => {
        const url = new URL(request.url, callback);
        const host = request.headers.host;
        if (request.method !== "GET" || url.pathname !== "/auth/callback" || !["localhost:1455", "127.0.0.1:1455"].includes(host)) { response.writeHead(404).end(); return; }
        if (url.searchParams.get("state") !== flow.state || busy) { response.writeHead(400).end("Invalid login callback."); return; }
        if (url.searchParams.has("error")) { clearTimeout(timer); response.writeHead(400).end("Login cancelled."); reject(new SetupError("Login cancelled.")); return; }
        const code = url.searchParams.get("code");
        if (!code || code.length > 2048) { response.writeHead(400).end("Missing login code."); return; }
        busy = true;
        try {
          const result = safeMetadata(await gateway.call("/login/complete", { code, state: flow.state }));
          clearTimeout(timer); response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("ChatGPT account connected. You can close this tab.");
          console.log(JSON.stringify(result, null, 2)); resolve();
        } catch (error) { clearTimeout(timer); response.writeHead(502).end("Login exchange failed. Return to the terminal."); reject(error); }
      });
      console.log("Choose your ChatGPT account and complete sign-in in the browser. The authorization code returns to this helper for exchange in your Worker.");
      console.log(authorization.toString()); openBrowser(authorization.toString());
    });
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(usage); return; }
  const config = unstable_readConfig({ config: path.resolve(process.cwd(), options.config), env: options.env }, { hideWarnings: true });
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); process.exitCode = 130; };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let gateway;
  try {
    gateway = await preview(config, controller.signal);
    if (controller.signal.aborted) throw new SetupError("Setup cancelled.");
    if (options.command === "login") await initialLogin(gateway, controller.signal);
    else console.log(JSON.stringify(safeMetadata(await gateway.call(options.command === "status" ? "/status" : "/renew")), null, 2));
  } finally { try { await gateway?.close(); } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); } }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(setupErrorMessage(error)); process.exitCode ||= 1; });

// @ts-expect-error The setup helper is a Node-only CLI outside the Worker TypeScript build.
import { parseOptions, validateOperatorConfig, createPreviewSource, createPreviewConfig, setupErrorMessage } from "../scripts/chatgpt-account.mjs";
import { describe, expect, it } from "vitest";

describe("ChatGPT setup helper boundaries", () => {
  it("uses a distinct preview Worker with an external deployed credential owner", () => {
    const configured = { name: "operator-worker", compatibility_date: "2026-10-01" };
    const preview = createPreviewConfig(configured, "operator-worker", "fixture-preview");
    expect(preview.name).not.toBe(configured.name);
    expect(preview.durable_objects.bindings).toEqual([{ name: "GPT_ACCOUNT", class_name: "GptAccount", script_name: "operator-worker" }]);
    expect(preview).not.toHaveProperty("migrations");
    expect(preview).not.toHaveProperty("vars");
  });
  it("reports its own configuration errors without echoing arbitrary upstream errors", () => {
    let error;
    try { parseOptions(["export-token"]); } catch (value) { error = value; }
    expect(setupErrorMessage(error)).toContain("Choose login, status, or renew");
    expect(setupErrorMessage(new Error("Bearer fixture-private-token"))).not.toContain("fixture-private-token");
  });
  it("defaults to the documented staging login and rejects unknown commands", () => {
    expect(parseOptions(["login"])).toMatchObject({ command: "login", env: "staging", config: "wrangler.jsonc" });
    expect(() => parseOptions(["export-token"])).toThrow();
    expect(() => parseOptions(["login", "--token", "never-read-this"])).toThrow();
  });
  it("refuses the public placeholders before starting a Cloudflare preview", () => {
    expect(() => validateOperatorConfig({ name: "op-redteam-mcp-staging", vars: { PUBLIC_ORIGIN: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev", MCP_RESOURCE: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev" } })).toThrow();
  });
  it("accepts the operator's matching origin and local credential binding", () => {
    const config = { name: "operator-worker", vars: { PUBLIC_ORIGIN: "https://operator-worker.example.net", MCP_RESOURCE: "https://operator-worker.example.net" }, durable_objects: { bindings: [{ name: "GPT_ACCOUNT", class_name: "GptAccount" }] } };
    expect(validateOperatorConfig(config)).toBe("operator-worker");
    expect(() => validateOperatorConfig({ ...config, vars: { ...config.vars, MCP_RESOURCE: "https://different.example.net" } })).toThrow();
  });
  it("a generated preview exposes safe setup/status actions but refuses credential retrieval", async () => {
    const source = createPreviewSource("a".repeat(64), Date.now() + 60000);
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    const missingGate = await module.default.fetch(new Request("https://preview/token", { method: "POST" }), {});
    expect(missingGate.status).toBe(401);
    // Hash mismatch rejects before any binding use, even if the caller asks a supported route.
    const wrongGate = await module.default.fetch(new Request("https://preview/status", { method: "POST", headers: { Authorization: "Bearer wrong-gate" } }), {});
    expect(wrongGate.status).toBe(401);
  });
  it("an authenticated preview forwards status only and cannot export an account token", async () => {
    const gate = "fixture-private-gate";
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gate)))].map(value => value.toString(16).padStart(2, "0")).join("");
    const module = await import(`data:text/javascript,${encodeURIComponent(createPreviewSource(hash, Date.now() + 60000))}`);
    const requests: string[] = [];
    const env = { GPT_ACCOUNT: { idFromName: (name: string) => name, get: () => ({ fetch: async (url: string) => { requests.push(url); return Response.json({ initialized: false }); } }) } };
    const request = (route: string) => new Request(`https://preview${route}`, { method: "POST", headers: { Authorization: `Bearer ${gate}` } });
    expect((await module.default.fetch(request("/token"), env)).status).toBe(404);
    expect(requests).toEqual([]);
    expect(await (await module.default.fetch(request("/status"), env)).json()).toEqual({ initialized: false });
    expect(requests).toEqual(["https://gpt-account/status"]);
  });
});

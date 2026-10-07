import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    Cloudflare: "{\"compatibilityFlags\":{\"global_fetch_strictly_public\":true}}",
  },
  ssr: {
    noExternal: ["@cloudflare/workers-oauth-provider", "agents", "partyserver"],
  },
  plugins: [
    {
      name: "cloudflare-workers-test-shim",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return "\0cloudflare-workers-test-shim";
        if (id === "cloudflare:email") return "\0cloudflare-email-test-shim";
        return undefined;
      },
      load(id) {
        if (id === "\0cloudflare-email-test-shim") return "export class EmailMessage {}";
        if (id !== "\0cloudflare-workers-test-shim") return undefined;
        return `
          export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
          export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
          export class RpcTarget {}
          export class WorkflowEntrypoint {}
          export const env = {};
          export const exports = {};
        `;
      },
    },
    {
      name: "op-text-modules",
      transform(source, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(source)}`, map: null };
        return undefined;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    restoreMocks: true,
  },
});

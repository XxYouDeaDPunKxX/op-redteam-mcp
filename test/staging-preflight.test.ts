import { describe, expect, it } from "vitest";
// @ts-expect-error The Worker project intentionally does not include Node declarations for this Node-side template check.
import { readFileSync } from "node:fs";
// @ts-expect-error The Worker project intentionally does not include declarations for this Node-side validation helper.
import { validateStagingTemplateValues } from "../scripts/staging-preflight-values.mjs";

describe("staging preflight", () => {
  it("keeps deployment allowlists empty in the committed example", () => {
    const template = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");

    expect(template).toMatch(/^ALLOWED_GITHUB_USER_IDS=$/m);
    expect(template).toMatch(/^ALLOWED_DCR_REDIRECT_URIS=$/m);
    expect(template).not.toContain("chatgpt.com");
  });

  it("fails closed while the committed staging template still has placeholders", () => {
    const failures = validateStagingTemplateValues({
      vars: {
        PUBLIC_ORIGIN: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
        MCP_RESOURCE: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
        ALLOWED_GITHUB_USER_IDS: "",
        ALLOWED_DCR_REDIRECT_URIS: "",
      },
      kv_namespaces: [{ binding: "OAUTH_KV", id: "00000000000000000000000000000000" }],
    });

    expect(failures).toEqual([
      "PUBLIC_ORIGIN must be replaced with the operator's HTTPS origin",
      "MCP_RESOURCE must be replaced with the operator's HTTPS resource URL",
      "ALLOWED_GITHUB_USER_IDS must contain at least one GitHub user ID",
      "ALLOWED_DCR_REDIRECT_URIS must contain at least one redirect URI",
      "OAUTH_KV must use a provisioned non-zero Cloudflare namespace id",
    ]);
  });
});

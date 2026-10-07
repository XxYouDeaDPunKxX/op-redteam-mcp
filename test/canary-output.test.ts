// @ts-expect-error Vitest executes this Node-only helper while the Worker project intentionally omits Node types.
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canaryResultPath } from "./canary-output";

declare const process: { cwd(): string; env: Record<string, string | undefined> };

afterEach(() => {
  delete process.env.CANARY_OUTPUT_DIR;
});

describe("canary result boundary", () => {
  it("fails closed when the operator has not supplied an output directory", () => {
    expect(() => canaryResultPath("result.json")).toThrow(/CANARY_OUTPUT_DIR/);
  });

  it("rejects an output directory inside the current checkout", () => {
    process.env.CANARY_OUTPUT_DIR = resolve(process.cwd(), "certification");
    expect(() => canaryResultPath("result.json")).toThrow(/outside the current checkout/);
  });

  it("rejects the checkout root even when the process cwd is nested", () => {
    const checkoutRoot = resolve(process.cwd());
    process.env.CANARY_OUTPUT_DIR = checkoutRoot;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(resolve(checkoutRoot, "test"));
    try {
      expect(() => canaryResultPath("result.json")).toThrow(/outside the current checkout/);
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects an output directory that does not exist yet", () => {
    process.env.CANARY_OUTPUT_DIR = resolve(process.cwd(), "..", "missing-private-canary-results");
    expect(() => canaryResultPath("result.json")).toThrow(/must be an existing directory/);
  });

  it("resolves result files under an absolute external directory", () => {
    const externalDirectory = resolve(process.cwd(), "..");
    process.env.CANARY_OUTPUT_DIR = externalDirectory;
    expect(canaryResultPath("result.json")).toBe(resolve(externalDirectory, "result.json"));
  });
});

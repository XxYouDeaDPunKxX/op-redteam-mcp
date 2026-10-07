import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Vitest executes this Node-only boundary test while the Worker project intentionally omits Node types.
import { resolve } from "node:path";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("node:fs");
  return {
    ...actual,
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => true })),
  };
});

import { canaryResultPath } from "./canary-output";

declare const process: { cwd(): string; env: Record<string, string | undefined> };

describe("canary result symlink boundary", () => {
  it("rejects a dangling result link even when existsSync would return false", () => {
    process.env.CANARY_OUTPUT_DIR = resolve(process.cwd(), "..");
    expect(() => canaryResultPath("dangling-result.json")).toThrow(/must not be a symbolic link/);
    delete process.env.CANARY_OUTPUT_DIR;
  });
});

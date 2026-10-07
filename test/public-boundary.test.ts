// @ts-expect-error Vitest executes this Node-only boundary test while the Worker project intentionally omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

declare const process: { cwd(): string };

function readPublic(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

describe("public boundary documentation", () => {
  it("contains current runtime markers and adapter claims only", () => {
    const readme = readPublic("README.md");
    const compatibility = readPublic("docs/ADAPTER-COMPATIBILITY.md");
    const evidence = readPublic("docs/MODEL-ADAPTER-EVIDENCE.md");

    expect(readme).not.toContain("__SERVER__");
    expect(readme).not.toContain("__SPARRING__");
    expect(readme).not.toContain("Gemini");
    expect(readme).toContain("CANARY_OUTPUT_DIR");
    expect(compatibility).not.toContain("extraction");
    expect(compatibility.replace(/\s+/g, " ")).toContain("Gemini has no active adapter or canary in the current source and is not a supported runtime route.");
    expect(evidence).not.toContain("older notes");
    expect(evidence).not.toContain("Raw provider envelopes");
    expect(evidence).not.toContain("local run artifacts");
    expect(evidence).not.toContain("The JSON preserves");
  });
});

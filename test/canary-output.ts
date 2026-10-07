// @ts-expect-error Vitest executes this Node-only helper while the Worker project intentionally omits Node types.
import { lstatSync, realpathSync, statSync } from "node:fs";
// @ts-expect-error Vitest executes this Node-only helper while the Worker project intentionally omits Node types.
import { isAbsolute, relative, resolve, sep } from "node:path";
// @ts-expect-error Vitest executes this Node-only helper while the Worker project intentionally omits Node types.
import { fileURLToPath } from "node:url";

declare const process: { cwd(): string; env: Record<string, string | undefined> };

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function canaryResultPath(filename: string): string {
  const configuredDirectory = process.env.CANARY_OUTPUT_DIR?.trim();
  if (!configuredDirectory || !isAbsolute(configuredDirectory)) {
    throw new Error("CANARY_OUTPUT_DIR must be an absolute directory outside the current checkout");
  }

  const outputDirectory = resolve(configuredDirectory);
  const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (isWithin(checkout, outputDirectory)) {
    throw new Error("CANARY_OUTPUT_DIR must be outside the current checkout");
  }
  let resolvedOutputDirectory: string;
  try {
    if (!statSync(outputDirectory).isDirectory()) throw new Error("not a directory");
    resolvedOutputDirectory = realpathSync(outputDirectory);
  } catch {
    throw new Error("CANARY_OUTPUT_DIR must be an existing directory");
  }
  if (isWithin(realpathSync(checkout), resolvedOutputDirectory)) {
    throw new Error("CANARY_OUTPUT_DIR must be outside the current checkout");
  }

  const resultPath = resolve(resolvedOutputDirectory, filename);
  if (!isWithin(resolvedOutputDirectory, resultPath)) throw new Error("Canary result filename must stay inside CANARY_OUTPUT_DIR");
  try {
    if (lstatSync(resultPath).isSymbolicLink()) throw new Error("Canary result path must not be a symbolic link");
  } catch (error) {
    if (error instanceof Error && error.message === "Canary result path must not be a symbolic link") throw error;
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return resultPath;
}

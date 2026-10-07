import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedTargets = new Set([
  resolve(projectRoot, "dist"),
  resolve(projectRoot, "dist", "staging"),
]);
const target = resolve(projectRoot, process.argv[2] ?? "");

if (!allowedTargets.has(target)) {
  throw new Error("build_output_target_not_allowed");
}

await rm(target, { recursive: true, force: true });

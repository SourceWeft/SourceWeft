import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typeScriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("generic normalization and observation layers contain no provider wire knowledge", () => {
  const forbidden = [
    /orcarouter/i,
    /x-orca-/i,
    /cost_usd/i,
    /inference_status/i,
    /upstream_inference_cost/i,
  ];
  const genericFiles = [
    ...typeScriptFiles(join(PACKAGE_ROOT, "src", "normalize")),
    ...typeScriptFiles(join(PACKAGE_ROOT, "src", "observation")),
  ];
  const violations = genericFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return forbidden.some((pattern) => pattern.test(source)) ? [path] : [];
  });

  assert.deepEqual(violations, []);
});

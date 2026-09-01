import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalProjectTree } from "../src/pipeline/project-validation";

test("canonical validation executes install, build, and smoke in order", async () => {
  const commands: string[] = [];
  const result = await validateCanonicalProjectTree({
    execute: async (command) => {
      commands.push(command);
      return { exitCode: 0, output: `${command}:ok` };
    },
  });

  assert.deepEqual(commands, [
    'pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --store-dir "${SOURCEWEFT_PNPM_STORE:-.pnpm-store}"',
    "pnpm run build",
    "pnpm run render-smoke",
  ]);
  assert.equal(result.install.ok, true);
  assert.equal(result.typecheck.ok, true);
  assert.equal(result.smoke.ok, true);
});

test("canonical validation stops after the first failed prerequisite", async () => {
  const commands: string[] = [];
  const result = await validateCanonicalProjectTree({
    execute: async (command) => {
      commands.push(command);
      return { exitCode: 1, output: "dependency install failed" };
    },
  });

  assert.deepEqual(commands, [
    'pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --store-dir "${SOURCEWEFT_PNPM_STORE:-.pnpm-store}"',
  ]);
  assert.deepEqual(result.install.diagnostics, ["dependency install failed"]);
  assert.equal(result.typecheck.ok, false);
  assert.equal(result.smoke.ok, false);
});

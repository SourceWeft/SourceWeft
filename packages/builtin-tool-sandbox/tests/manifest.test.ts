import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { builtinSandboxCapabilityManifest } from "../src";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json matches the package manifest export", async () => {
  const { raw } = await loadCapabilityManifestFixture(packageRoot);

  assert.deepEqual(raw, builtinSandboxCapabilityManifest);
});

test("sandbox manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinSandboxCapabilityManifest,
  );
  const tools = manifest.contributes.tools;

  assert.ok(tools.some((tool) => tool.id === "prepare_sandbox_workspace"));
  assert.ok(tools.some((tool) => tool.id === "execute"));
});

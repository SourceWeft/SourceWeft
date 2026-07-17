import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { builtinSandboxCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(JSON.parse(rawManifest), builtinSandboxCapabilityManifest);
});

test("sandbox manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinSandboxCapabilityManifest,
  );
  const tools = getCapabilityContributions(manifest).tools;

  assert.ok(tools.some((tool) => tool.id === "prepare_sandbox_workspace"));
  assert.ok(tools.some((tool) => tool.id === "execute"));
});

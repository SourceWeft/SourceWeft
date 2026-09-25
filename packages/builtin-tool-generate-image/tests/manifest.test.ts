import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  parseCapabilityManifest,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { builtinGenerateImageCapabilityManifest } from "../src";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json matches the package manifest export", async () => {
  const { raw } = await loadCapabilityManifestFixture(packageRoot);

  assert.deepEqual(raw, builtinGenerateImageCapabilityManifest);
});

test("generate-image manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinGenerateImageCapabilityManifest,
  );
  const tools = manifest.contributes.tools;

  assert.equal(tools[0]?.id, "generate_image");
  assert.deepEqual(
    tools[0]?.options.map((option) => option.target?.path),
    ["config.aspectRatio", "config.quality", "config.style"],
  );
});

test("generate-image manifest rejects malformed tool metadata", () => {
  const result = parseCapabilityManifest({
    ...builtinGenerateImageCapabilityManifest,
    tools: [
      {
        ...(builtinGenerateImageCapabilityManifest.tools?.[0] ?? {}),
        id: "INVALID ID",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});

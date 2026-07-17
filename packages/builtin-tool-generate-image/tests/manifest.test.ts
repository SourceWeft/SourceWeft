import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  capabilityManifestSchema,
  parseCapabilityManifest,
} from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { builtinGenerateImageCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinGenerateImageCapabilityManifest,
  );
});

test("generate-image manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinGenerateImageCapabilityManifest,
  );
  const tools = getCapabilityContributions(manifest).tools;

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

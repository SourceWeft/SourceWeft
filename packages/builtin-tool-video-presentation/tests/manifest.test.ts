import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { builtinGenerateVideoPresentationCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinGenerateVideoPresentationCapabilityManifest,
  );
});

test("video-presentation manifest exposes executor-only tool contributions", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinGenerateVideoPresentationCapabilityManifest,
  );
  const tool = getCapabilityContributions(manifest).tools[0];

  assert.equal(tool?.id, "generate_video_presentation");
  assert.equal(tool?.command, undefined);
});

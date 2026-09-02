import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { builtinPublishArtifactCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinPublishArtifactCapabilityManifest,
  );
});

test("publish-artifact manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinPublishArtifactCapabilityManifest,
  );
  const tools = manifest.contributes.tools;

  assert.equal(tools[0]?.id, "publish_artifact");
});

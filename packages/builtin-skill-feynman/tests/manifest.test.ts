import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json parses as a valid feynman skill manifest", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );
  const manifest = capabilityManifestSchema.parse(JSON.parse(rawManifest));
  const skill = manifest.contributes.skills[0];

  assert.equal(manifest.id, "sourceweft/feynman");
  assert.equal(skill?.id, "feynman");
});

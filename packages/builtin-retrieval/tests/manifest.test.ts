import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { builtinRetrievalCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinRetrievalCapabilityManifest,
  );
});

test("retrieval manifest exposes search_sources tool contribution", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinRetrievalCapabilityManifest,
  );

  assert.equal(manifest.id, "sourceweft/retrieval");
  assert.deepEqual(
    manifest.contributes.tools?.map((tool) => tool.id),
    ["search_sources"],
  );
  assert.deepEqual(
    manifest.contributes.retrieval?.map((entry) => entry.id),
    ["workspace"],
  );
});

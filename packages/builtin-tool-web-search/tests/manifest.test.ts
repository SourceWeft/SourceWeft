import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json parses as a valid web-search manifest", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );
  const manifest = capabilityManifestSchema.parse(JSON.parse(rawManifest));

  assert.equal(manifest.id, "sourceweft/web-search");
  assert.deepEqual(
    manifest.contributes.tools.map((tool) => tool.id),
    ["web_search", "web_fetch"],
  );
});

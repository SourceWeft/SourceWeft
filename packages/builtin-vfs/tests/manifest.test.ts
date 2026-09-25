import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json parses as a vfs capability manifest", async () => {
  const { manifest } = await loadCapabilityManifestFixture(packageRoot);

  assert.equal(manifest.id, "sourceweft/vfs");
  assert.equal(manifest.kind, "vfs");
  assert.deepEqual(
    manifest.contributes.vfs?.map((entry) => entry.id),
    ["workspace"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json parses as a valid web-search manifest", async () => {
  const { manifest } = await loadCapabilityManifestFixture(packageRoot);

  assert.equal(manifest.id, "sourceweft/web-search");
  assert.deepEqual(
    manifest.contributes.tools.map((tool) => tool.id),
    ["web_search", "web_fetch"],
  );
});

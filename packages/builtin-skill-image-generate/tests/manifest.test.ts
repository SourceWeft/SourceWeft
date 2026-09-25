import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json parses as a valid image-generate skill manifest", async () => {
  const { manifest } = await loadCapabilityManifestFixture(packageRoot);
  const skill = manifest.contributes.skills[0];

  assert.equal(manifest.id, "sourceweft/image-generate");
  assert.equal(skill?.id, "image-generate");
  assert.equal(skill?.defaultEnabled, true);
});

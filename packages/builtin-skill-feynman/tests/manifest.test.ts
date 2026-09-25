import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json parses as a valid feynman skill manifest", async () => {
  const { manifest } = await loadCapabilityManifestFixture(packageRoot);
  const skill = manifest.contributes.skills[0];

  assert.equal(manifest.id, "sourceweft/feynman");
  assert.equal(skill?.id, "feynman");
});

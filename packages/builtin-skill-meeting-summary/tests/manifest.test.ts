import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json parses as a valid meeting-summary skill manifest", async () => {
  const { manifest } = await loadCapabilityManifestFixture(packageRoot);
  const skill = manifest.contributes.skills[0];

  assert.equal(manifest.id, "sourceweft/meeting-summary");
  assert.equal(skill?.id, "meeting-summary");
});

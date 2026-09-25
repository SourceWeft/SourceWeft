import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { builtinPublishArtifactCapabilityManifest } from "../src";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json matches the package manifest export", async () => {
  const { raw } = await loadCapabilityManifestFixture(packageRoot);

  assert.deepEqual(raw, builtinPublishArtifactCapabilityManifest);
});

test("publish-artifact manifest exposes tool contributions after parse", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinPublishArtifactCapabilityManifest,
  );
  const tools = manifest.contributes.tools;

  assert.equal(tools[0]?.id, "publish_artifact");
});

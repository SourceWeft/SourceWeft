import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { builtinRetrievalCapabilityManifest } from "../src";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json matches the package manifest export", async () => {
  const { raw } = await loadCapabilityManifestFixture(packageRoot);

  assert.deepEqual(raw, builtinRetrievalCapabilityManifest);
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

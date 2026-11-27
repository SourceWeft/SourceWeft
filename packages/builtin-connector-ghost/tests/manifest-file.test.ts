import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  connectorContributionSchema,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinGhostConnectorCapabilityManifest,
  ghostConnectorContribution,
  toBackendGhostManifest,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinGhostConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinGhostConnectorCapabilityManifest);
});

test("the capability declares one connector, ghost, with the expected identity", () => {
  assert.equal(builtinGhostConnectorCapabilityManifest.id, "sourceweft/ghost");
  assert.equal(builtinGhostConnectorCapabilityManifest.kind, "connector");
  assert.equal(builtinGhostConnectorCapabilityManifest.version, "0.1.0");
  assert.equal(builtinGhostConnectorCapabilityManifest.connectors.length, 1);
  assert.equal(
    builtinGhostConnectorCapabilityManifest.connectors[0].id,
    "ghost",
  );
});

test("the contribution is an api_key credential connector with browse, search and describe", () => {
  const c = ghostConnectorContribution;
  assert.equal(c.title, "Ghost");
  assert.deepEqual(c.auth, { kind: "credential", scheme: "api_key" });
  assert.equal(c.sync.supportsIncremental, false);
  assert.equal(c.sync.defaultFrequencyMinutes, 360);
  assert.equal(c.sync.minFrequencyMinutes, 60);
  assert.deepEqual(c.sync.resources, [
    {
      type: "ghost_content",
      title: "Post or page",
      supportsDeleteDetection: true,
    },
  ]);
  assert.deepEqual(c.selection, {
    actions: {
      browse: "ghost.browse",
      search: "ghost.search",
      describe: "ghost.describe",
    },
    kinds: ["type", "tag", "post", "page"],
    maxItems: 500,
  });
  assert.deepEqual(
    c.actions.map((a) => a.id),
    ["ghost.browse", "ghost.search", "ghost.describe"],
  );
  for (const action of c.actions) {
    assert.equal(action.visibility, "internal");
    assert.equal(action.risk, "low");
    assert.equal(action.requiresApproval, false);
    assert.deepEqual(action.capabilities, ["connector_read"]);
  }
  connectorContributionSchema.parse(c);
});

test("backend manifest carries the api_key credential auth and the selection spec", () => {
  const manifest = connectorManifestSchema.parse(toBackendGhostManifest());
  assert.equal(manifest.type, "ghost");
  assert.equal(manifest.displayName, "Ghost");
  assert.deepEqual(manifest.auth, { kind: "credential", scheme: "api_key" });
  assert.equal(manifest.sync.resources[0]!.supportsDeleteDetection, true);
  assert.deepEqual(
    manifest.actions.map((a) => a.type),
    ["ghost.browse", "ghost.search", "ghost.describe"],
  );
  assert.equal(manifest.selection?.actions.browse, "ghost.browse");
  assert.equal(manifest.selection?.actions.search, "ghost.search");
  assert.equal(manifest.selection?.actions.describe, "ghost.describe");
  assert.equal(manifest.selection?.maxItems, 500);
});

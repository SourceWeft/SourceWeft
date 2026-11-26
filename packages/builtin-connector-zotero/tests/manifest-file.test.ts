import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  connectorContributionSchema,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinZoteroConnectorCapabilityManifest,
  toBackendZoteroManifest,
  zoteroConnectorContribution,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinZoteroConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinZoteroConnectorCapabilityManifest);
});

test("the capability declares one connector, zotero, with the expected identity", () => {
  assert.equal(
    builtinZoteroConnectorCapabilityManifest.id,
    "sourceweft/zotero",
  );
  assert.equal(builtinZoteroConnectorCapabilityManifest.kind, "connector");
  assert.equal(builtinZoteroConnectorCapabilityManifest.version, "0.1.0");
  assert.equal(builtinZoteroConnectorCapabilityManifest.connectors.length, 1);
  assert.equal(
    builtinZoteroConnectorCapabilityManifest.connectors[0].id,
    "zotero",
  );
});

test("the contribution is an api_key credential connector with browse and describe", () => {
  const c = zoteroConnectorContribution;
  assert.deepEqual(c.auth, { kind: "credential", scheme: "api_key" });
  assert.equal(c.sync.supportsIncremental, false);
  assert.equal(c.sync.defaultFrequencyMinutes, 360);
  assert.equal(c.sync.minFrequencyMinutes, 60);
  assert.deepEqual(c.sync.resources, [
    {
      type: "zotero_item",
      title: "Zotero item",
      supportsDeleteDetection: true,
    },
  ]);
  assert.deepEqual(c.selection, {
    actions: { browse: "zotero.browse", describe: "zotero.describe" },
    kinds: ["collection"],
    maxItems: 50,
  });
  assert.deepEqual(
    c.actions.map((a) => a.id),
    ["zotero.browse", "zotero.describe"],
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
  const manifest = connectorManifestSchema.parse(toBackendZoteroManifest());
  assert.equal(manifest.type, "zotero");
  assert.equal(manifest.displayName, "Zotero");
  assert.deepEqual(manifest.auth, { kind: "credential", scheme: "api_key" });
  assert.equal(manifest.sync.resources[0]!.supportsDeleteDetection, true);
  assert.deepEqual(
    manifest.actions.map((a) => a.type),
    ["zotero.browse", "zotero.describe"],
  );
  assert.equal(manifest.selection?.actions.browse, "zotero.browse");
  assert.equal(manifest.selection?.maxItems, 50);
});

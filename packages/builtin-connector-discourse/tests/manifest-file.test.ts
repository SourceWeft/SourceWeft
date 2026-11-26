import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  connectorContributionSchema,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinDiscourseConnectorCapabilityManifest,
  discourseConnectorContribution,
  toBackendDiscourseManifest,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinDiscourseConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinDiscourseConnectorCapabilityManifest);
});

test("the capability declares one connector, discourse, with the expected identity", () => {
  const manifest = builtinDiscourseConnectorCapabilityManifest;
  assert.equal(manifest.id, "sourceweft/discourse");
  assert.equal(manifest.kind, "connector");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.connectors.length, 1);
  assert.equal(manifest.connectors[0].id, "discourse");
});

test("the contribution is an auth-less forum connector with browse, search and describe", () => {
  const c = discourseConnectorContribution;
  assert.equal(c.title, "Discourse forum");
  assert.deepEqual(c.auth, { kind: "none" });
  assert.equal(c.sync.supportsIncremental, false);
  assert.equal(c.sync.defaultFrequencyMinutes, 360);
  assert.equal(c.sync.minFrequencyMinutes, 60);
  assert.deepEqual(c.sync.resources, [
    {
      type: "discourse_topic",
      title: "Forum topic",
      supportsDeleteDetection: true,
    },
  ]);
  assert.deepEqual(c.selection, {
    actions: {
      browse: "discourse.browse",
      search: "discourse.search",
      describe: "discourse.describe",
    },
    kinds: ["category", "topic"],
    maxItems: 500,
  });
  assert.deepEqual(
    c.actions.map((a) => a.id),
    ["discourse.browse", "discourse.search", "discourse.describe"],
  );
  for (const action of c.actions) {
    assert.equal(action.visibility, "internal");
    assert.equal(action.risk, "low");
    assert.equal(action.requiresApproval, false);
    assert.deepEqual(action.capabilities, ["connector_read"]);
  }
  connectorContributionSchema.parse(c);
});

test("backend manifest is a none-auth connector carrying the selection spec", () => {
  const manifest = connectorManifestSchema.parse(toBackendDiscourseManifest());
  assert.equal(manifest.type, "discourse");
  assert.equal(manifest.displayName, "Discourse forum");
  assert.deepEqual(manifest.auth, { kind: "none" });
  assert.equal(manifest.sync.resources[0]!.type, "discourse_topic");
  assert.equal(manifest.sync.resources[0]!.supportsDeleteDetection, true);
  assert.deepEqual(
    manifest.actions.map((a) => a.type),
    ["discourse.browse", "discourse.search", "discourse.describe"],
  );
  assert.equal(manifest.selection?.actions.browse, "discourse.browse");
  assert.equal(manifest.selection?.actions.search, "discourse.search");
  assert.equal(manifest.selection?.maxItems, 500);
});

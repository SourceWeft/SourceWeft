import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinRssConnectorCapabilityManifest,
  rssConnectorContribution,
  toBackendRssManifest,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinRssConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinRssConnectorCapabilityManifest);
});

test("the contribution is an auth-less feed connector with only a feedUrl", () => {
  assert.equal(rssConnectorContribution.id, "rss");
  assert.equal(rssConnectorContribution.title, "RSS / Atom feed");
  assert.deepEqual(rssConnectorContribution.auth, { kind: "none" });
  assert.deepEqual(rssConnectorContribution.configSchema, {
    type: "object",
    additionalProperties: false,
    required: ["feedUrl"],
    properties: {
      feedUrl: {
        type: "string",
        pattern: "^https://[^/?#@\\s]{1,253}([/?#]\\S{0,2040})?$",
      },
    },
  });
});

test("backend manifest is a none-auth connector with one feed_item resource", () => {
  const manifest = connectorManifestSchema.parse(toBackendRssManifest());
  assert.equal(manifest.type, "rss");
  assert.equal(manifest.displayName, "RSS / Atom feed");
  assert.equal(manifest.auth.kind, "none");
  assert.equal(manifest.actions.length, 0);
  assert.equal(manifest.selection, undefined);
  assert.equal(manifest.sync.supportsIncremental, true);
  assert.equal(manifest.sync.defaultFrequencyMinutes, 360);
  assert.equal(manifest.sync.minFrequencyMinutes, 30);
  assert.equal(manifest.sync.resources.length, 1);
  const resource = manifest.sync.resources[0]!;
  assert.equal(resource.type, "feed_item");
  assert.equal(resource.supportsDeleteDetection, false);
});

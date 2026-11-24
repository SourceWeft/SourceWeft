import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  connectorContributionSchema,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinWebDavConnectorCapabilityManifest,
  toBackendWebDavManifest,
  webDavConnectorContribution,
  MAX_FILE_BYTES,
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_ROOTS,
  MAX_MULTISTATUS_BYTES,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinWebDavConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinWebDavConnectorCapabilityManifest);
});

test("the contribution is a basic-credential connector with browse and describe", () => {
  const c = webDavConnectorContribution;
  assert.equal(c.id, "webdav");
  assert.deepEqual(c.auth, { kind: "credential", scheme: "basic" });
  assert.equal(c.sync.resources.length, 1);
  assert.equal(c.sync.resources[0]!.supportsDeleteDetection, true);
  assert.equal(c.selection.actions.browse, "webdav.browse");
  assert.equal(c.selection.actions.describe, "webdav.describe");
  assert.deepEqual(
    c.actions.map((a) => a.id),
    ["webdav.browse", "webdav.describe"],
  );
  for (const action of c.actions) {
    assert.equal(action.visibility, "internal");
    assert.equal(action.risk, "low");
    assert.equal(action.requiresApproval, false);
    assert.deepEqual(action.capabilities, ["connector_read"]);
  }
  connectorContributionSchema.parse(c);
});

test("config schema is exactly endpoint and roots, with no credential field", () => {
  const schema = webDavConnectorContribution.configSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "endpoint",
    "roots",
  ]);
  assert.deepEqual([...schema.required].sort(), ["endpoint", "roots"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.roots.maxItems, MAX_ROOTS);
  assert.equal(schema.properties.roots.minItems, 1);
});

test("limits hold the documented values", () => {
  assert.equal(MAX_DEPTH, 8);
  assert.equal(MAX_ENTRIES, 20_000);
  assert.equal(MAX_ROOTS, 20);
  assert.equal(MAX_MULTISTATUS_BYTES, 5 * 1024 * 1024);
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(SCAN_TIMEOUT_MS, 10 * 60_000);
  // Same ceiling the connector pipeline applies to every download (Dropbox).
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});

test("backend manifest carries the credential auth and the selection spec", () => {
  const manifest = connectorManifestSchema.parse(toBackendWebDavManifest());
  assert.equal(manifest.type, "webdav");
  assert.equal(manifest.displayName, "WebDAV");
  assert.deepEqual(manifest.auth, { kind: "credential", scheme: "basic" });
  assert.equal(manifest.sync.resources[0]!.supportsDeleteDetection, true);
  assert.deepEqual(
    manifest.actions.map((a) => a.type),
    ["webdav.browse", "webdav.describe"],
  );
  assert.equal(manifest.selection?.actions.browse, "webdav.browse");
  assert.equal(manifest.selection?.actions.describe, "webdav.describe");
  assert.equal(manifest.selection?.maxItems, MAX_ROOTS);
});

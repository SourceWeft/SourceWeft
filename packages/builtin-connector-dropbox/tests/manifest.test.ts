import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  DROPBOX_SCOPES,
  builtinDropboxConnectorCapabilityManifest,
  toBackendDropboxManifest,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinDropboxConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinDropboxConnectorCapabilityManifest);
});

test("backend manifest exposes the Dropbox scopes, client id and redirect uri", () => {
  const manifest = toBackendDropboxManifest({
    clientId: "app-key",
    redirectUri: "https://sourceweft.example/callback",
  });

  assert.equal(manifest.type, "dropbox");
  assert.deepEqual(manifest.auth.scopes, [...DROPBOX_SCOPES]);
  assert.deepEqual(manifest.auth.authorizationParams, {
    token_access_type: "offline",
    client_id: "app-key",
  });
  assert.equal(
    manifest.auth.redirectUri,
    "https://sourceweft.example/callback",
  );
  assert.equal(manifest.sync.supportsIncremental, false);
  assert.equal(manifest.actions.length, 3);
  for (const action of manifest.actions) {
    assert.equal(action.visibility, "internal");
  }
  assert.deepEqual(manifest.selection, {
    actions: {
      browse: "dropbox.browse",
      search: "dropbox.search",
      describe: "dropbox.describe",
    },
    kinds: ["folder", "file"],
    maxItems: 500,
  });
});

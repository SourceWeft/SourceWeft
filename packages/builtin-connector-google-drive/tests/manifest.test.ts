import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import type { ConnectorManifest } from "@sourceweft/contracts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  builtinGoogleDriveConnectorCapabilityManifest,
  toBackendGoogleDriveManifest,
} from "../src";

const root = new URL("../", import.meta.url);

// The manifest always uses the platform's standard OAuth2 flow; this narrows
// the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinGoogleDriveConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinGoogleDriveConnectorCapabilityManifest);
});

test("backend manifest exposes only the Drive file scope and is not incremental", () => {
  const manifest = toBackendGoogleDriveManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });
  assert.deepEqual(oauth2Auth(manifest).scopes, [GOOGLE_DRIVE_FILE_SCOPE]);
  assert.equal(manifest.sync.supportsIncremental, false);
  assert.equal(manifest.actions.length, 1);
});

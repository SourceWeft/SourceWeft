import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import type { ConnectorManifest } from "@sourceweft/contracts";
import {
  builtinGmailConnectorCapabilityManifest,
  toBackendGmailManifest,
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
  assert.deepEqual(raw, builtinGmailConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinGmailConnectorCapabilityManifest);
});

test("backend manifest includes only read and send scopes", () => {
  const manifest = toBackendGmailManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });
  assert.equal(oauth2Auth(manifest).scopes.length, 2);
  assert.equal(
    manifest.actions.find((action) => action.type === "gmail.message.send")
      ?.allowStandingApproval,
    false,
  );
});

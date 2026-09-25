import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  builtinGmailConnectorCapabilityManifest,
  toBackendGmailManifest,
} from "../src";

const root = new URL("../", import.meta.url);

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
  assert.equal(manifest.auth.scopes.length, 2);
  assert.equal(
    manifest.actions.find((action) => action.type === "gmail.message.send")
      ?.allowStandingApproval,
    false,
  );
});

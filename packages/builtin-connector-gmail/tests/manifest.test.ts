import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import {
  builtinGmailConnectorCapabilityManifest,
  toBackendGmailManifest,
} from "../src";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("JSON capability manifest matches the TypeScript export", async () => {
  const raw = await readFile(join(root, "sourceweft.capability.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), builtinGmailConnectorCapabilityManifest);
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

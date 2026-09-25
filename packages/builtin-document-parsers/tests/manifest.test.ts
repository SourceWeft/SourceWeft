import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { builtinDocumentParsersCapabilityManifest } from "../src";

const packageRoot = new URL("../", import.meta.url);

test("sourceweft.capability.json matches the package manifest export", async () => {
  const { raw } = await loadCapabilityManifestFixture(packageRoot);

  assert.deepEqual(raw, builtinDocumentParsersCapabilityManifest);
});

test("document parsers manifest exposes workspace parser contribution", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinDocumentParsersCapabilityManifest,
  );

  assert.equal(manifest.id, "sourceweft/document-parsers");
  assert.deepEqual(
    manifest.contributes.documentParsers?.map((entry) => entry.id),
    ["workspace-documents"],
  );
});

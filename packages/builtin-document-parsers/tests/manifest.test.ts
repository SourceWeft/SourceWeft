import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { builtinDocumentParsersCapabilityManifest } from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinDocumentParsersCapabilityManifest,
  );
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
  assert.ok(
    (manifest.contributes.documentParsers?.[0]?.mimeTypes.length ?? 0) > 0,
  );
});

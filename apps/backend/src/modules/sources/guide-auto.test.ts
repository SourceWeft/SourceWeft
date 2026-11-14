import assert from "node:assert/strict";
import { test } from "vitest";
import { shouldAutoGenerateGuide } from "./guide-service";

const source = {
  id: "s1",
  ingestKind: "manual_upload",
  connectorId: null,
  contentHash: "h",
  status: "indexed",
};

test("sources a person adds directly are guided automatically", () => {
  for (const ingestKind of ["manual_upload", "web_url", "youtube"]) {
    assert.equal(shouldAutoGenerateGuide({ ...source, ingestKind }), true);
  }
});

test("connector-synced sources are never guided automatically", () => {
  assert.equal(
    shouldAutoGenerateGuide({ ...source, ingestKind: "connector", connectorId: "c1" }),
    false,
  );
  assert.equal(shouldAutoGenerateGuide({ ...source, connectorId: "c1" }), false);
});

test("notes, artifacts and unfinished sources are not guided automatically", () => {
  assert.equal(shouldAutoGenerateGuide({ ...source, ingestKind: "note" }), false);
  assert.equal(shouldAutoGenerateGuide({ ...source, ingestKind: "artifact" }), false);
  assert.equal(shouldAutoGenerateGuide({ ...source, status: "processing" }), false);
});

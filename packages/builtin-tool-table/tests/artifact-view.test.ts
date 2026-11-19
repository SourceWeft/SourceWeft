import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactViewHandlers } from "../src/index";
import { COLUMN_NOTE, found, makeTable } from "./table-fixture";

function record(artifactType: string, payloadJson: unknown, title: string | null = "Q3 vendors") {
  return {
    artifactType,
    status: "ready",
    title,
    storageBucket: null,
    storageKey: null,
    payloadJson,
  };
}

const table = makeTable([{ n: 1, title: "A", cells: { [COLUMN_NOTE]: found("x") } }]);

test("the package takes over the table artifact type only", async () => {
  const handlers = await createArtifactViewHandlers();
  assert.deepEqual(
    handlers.map((handler) => handler.artifactType),
    ["table"],
  );
});

test("a table owns no storage objects, so deleting one leaves nothing behind", async () => {
  const [handler] = await createArtifactViewHandlers();
  assert.ok(handler!.listOwnedStorageObjects);
  assert.deepEqual(handler!.listOwnedStorageObjects({ artifact: record("table", table) }), []);
  assert.equal(handler!.resolveVersionMedia, undefined);
  assert.equal(handler!.resolveAsset, undefined);
});

test("source JSON is the validated content under <title>.table.json", async () => {
  const [handler] = await createArtifactViewHandlers();
  const built = handler!.buildSourceJson?.({ artifact: record("table", table) });
  assert.deepEqual(built?.payload, table);
  assert.equal(built?.fileName, "Q3 vendors.table.json");
});

test("the file name is path- and control-safe and never empty", async () => {
  const [handler] = await createArtifactViewHandlers();
  const name = (title: string | null) =>
    handler!.buildSourceJson?.({ artifact: record("table", table, title) })?.fileName;
  assert.equal(name('a/b\\c:d*e?"f<g>h|i\u0000j'), "a b c d e f g h i j.table.json");
  assert.equal(name(null), "table.table.json");
  assert.equal(name("  /  "), "table.table.json");
  assert.equal(name("x".repeat(200)), `${"x".repeat(80)}.table.json`);
});

test("source JSON is null for content that is not a valid table", async () => {
  const [handler] = await createArtifactViewHandlers();
  assert.equal(handler!.buildSourceJson?.({ artifact: record("table", { nope: 1 }) }), null);
  assert.equal(handler!.buildSourceJson?.({ artifact: record("table", null) }), null);
});

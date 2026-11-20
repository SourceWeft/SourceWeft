import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTableContent } from "@sourceweft/contracts/table";
import { createArtifactViewHandlers } from "../src/index";
import { withoutEvidence } from "../src/ui/table-model";
import {
  COLUMN_DATE,
  COLUMN_NOTE,
  COLUMN_PRICE,
  found,
  makeTable,
  notFound,
  unverified,
} from "./table-fixture";

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

/* ------------------------------------------------------------ public share */

const sharedTable = makeTable([
  {
    n: 1,
    title: "Atlas pricing sheet",
    cells: {
      [COLUMN_PRICE]: found("$40", ["The list price is $40 per seat."], 40),
      [COLUMN_NOTE]: notFound,
    },
  },
  { n: 2, title: "Beacon brochure", cells: { [COLUMN_DATE]: unverified } },
]);
// Offsets and a heading path, as the anchored engine writes them.
const anchored = JSON.parse(JSON.stringify(sharedTable)) as typeof sharedTable;
const anchoredCell = anchored.rows[0]!.cells[COLUMN_PRICE]!;
if (anchoredCell.status === "found") {
  Object.assign(anchoredCell.evidence[0]!, {
    startChar: 4,
    endChar: 35,
    chunkNo: 2,
    headingPath: "Pricing > Seats",
  });
}

async function publicPayload(payloadJson: unknown) {
  const [handler] = await createArtifactViewHandlers();
  assert.ok(handler!.buildPublicPayload, "the table offers a public payload");
  return handler!.buildPublicPayload({
    artifact: record("table", payloadJson),
    assetUrl: (fileName) => `/public/${fileName}`,
  });
}

test("the public payload of a table has no evidence quote, start or end offsets", async () => {
  const payload = await publicPayload(anchored);
  assert.ok(payload);
  const serialized = JSON.stringify(payload);
  for (const field of ["quote", "startChar", "endChar", "quoteHash", "headingPath"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"`), field);
  }
  assert.doesNotMatch(serialized, /per seat/);
  const cell = (payload as typeof sharedTable).rows[0]!.cells[COLUMN_PRICE];
  assert.deepEqual(cell, {
    status: "found",
    value: "$40",
    normalized: 40,
    evidence: [
      { kind: "chunk", sourceId: "s1", documentId: "doc-s1", chunkId: "chunk-s1", chunkNo: 2 },
    ],
    fingerprint: "0123456789abcdef",
  });
});

test("the public payload keeps values, column names and types, and source titles", async () => {
  const payload = (await publicPayload(anchored)) as typeof sharedTable;
  assert.deepEqual(
    payload.columns.map(({ name, type }) => ({ name, type })),
    [
      { name: "Price", type: "number" },
      { name: "Date", type: "date" },
      { name: "Note", type: "text" },
    ],
  );
  assert.deepEqual(
    payload.rows.map((row) => row.title),
    ["Atlas pricing sheet", "Beacon brochure"],
  );
  assert.deepEqual(payload.rows[0]!.cells[COLUMN_NOTE], notFound);
  assert.deepEqual(payload.rows[1]!.cells[COLUMN_DATE], unverified);
  assert.equal(payload.kind, "table");
  assert.equal(payload.language, "en");
});

test("the public payload drops whatever is not table content", async () => {
  const payload = await publicPayload({
    ...anchored,
    table: { checkpoint: { rows: { secret: "chunk text" } } },
  });
  assert.equal((payload as Record<string, unknown>).table, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /chunk text/);
});

test("there is no public payload for content that is not a valid table", async () => {
  assert.equal(await publicPayload({ nope: 1 }), null);
  assert.equal(await publicPayload(null), null);
});

test("the stripped public payload still opens in the share viewer's parser", async () => {
  const payload = await publicPayload(anchored);
  const parsed = parseTableContent(withoutEvidence(payload));
  assert.deepEqual(
    parsed.rows.map((row) => row.title),
    ["Atlas pricing sheet", "Beacon brochure"],
  );
  assert.doesNotMatch(JSON.stringify(parsed), /per seat/);
});

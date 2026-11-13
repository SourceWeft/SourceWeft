import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSkippedItemSchema,
  readConnectorSkippedItems,
} from "../src/connectors";

test("reads well-formed skipped items from run metadata", () => {
  const items = readConnectorSkippedItems({
    skippedItems: [
      { externalId: "file:a", title: "Report", reason: "too_large" },
      { externalId: "file:b", title: null, reason: "needs_ocr" },
    ],
  });
  assert.deepEqual(items, [
    { externalId: "file:a", title: "Report", reason: "too_large" },
    { externalId: "file:b", title: null, reason: "needs_ocr" },
  ]);
});

test("keeps entries whose reason is unknown to the current UI", () => {
  const items = readConnectorSkippedItems({
    skippedItems: [{ externalId: "file:a", title: "x", reason: "brand_new" }],
  });
  assert.deepEqual(items, [
    { externalId: "file:a", title: "x", reason: "brand_new" },
  ]);
});

test("drops malformed entries without dropping the good ones", () => {
  const items = readConnectorSkippedItems({
    skippedItems: [
      { externalId: "file:a", title: "a", reason: "too_large" },
      { title: "no external id", reason: "too_large" },
      { externalId: "file:c", reason: "" },
      { externalId: "", reason: "too_large" },
      null,
      "nonsense",
      42,
    ],
  });
  assert.deepEqual(items, [
    { externalId: "file:a", title: "a", reason: "too_large" },
  ]);
});

test("coerces a missing or non-string title to null", () => {
  const items = readConnectorSkippedItems({
    skippedItems: [
      { externalId: "file:a", reason: "unreadable" },
      { externalId: "file:b", title: 7, reason: "unreadable" },
    ],
  });
  assert.deepEqual(items, [
    { externalId: "file:a", title: null, reason: "unreadable" },
    { externalId: "file:b", title: null, reason: "unreadable" },
  ]);
});

test("returns an empty array for metadata without a skippedItems array", () => {
  assert.deepEqual(readConnectorSkippedItems({}), []);
  assert.deepEqual(readConnectorSkippedItems({ skippedItems: "nope" }), []);
  assert.deepEqual(readConnectorSkippedItems(null), []);
  assert.deepEqual(readConnectorSkippedItems(undefined), []);
  assert.deepEqual(readConnectorSkippedItems("string"), []);
});

test("the item schema accepts a null title and rejects a missing reason", () => {
  assert.equal(
    connectorSkippedItemSchema.safeParse({
      externalId: "file:a",
      title: null,
      reason: "too_large",
    }).success,
    true,
  );
  assert.equal(
    connectorSkippedItemSchema.safeParse({
      externalId: "file:a",
      title: "a",
    }).success,
    false,
  );
});

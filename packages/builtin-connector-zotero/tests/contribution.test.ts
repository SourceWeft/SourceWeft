import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OBJECTS,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RESTARTS,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_BACKOFF_WAIT_MS,
  MAX_SELECTED_COLLECTIONS,
  MAX_TEXT_CHARS,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  SHORTCUT_MAX_AGE_MS,
  zoteroConnectorContribution,
} from "../src";

// A minimal JSON Schema subset check, covering exactly the keywords the
// contribution schemas use (type, enum, pattern, min/maxItems, maxLength,
// uniqueItems, items, properties, required, additionalProperties).
function valid(schema: any, value: unknown): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) return false;
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return false;
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      return false;
    if (schema.items && !value.every((v) => valid(schema.items, v)))
      return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) return false;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record))
        if (!(key in (schema.properties ?? {}))) return false;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record && !valid(child, record[key])) return false;
    }
  }
  return true;
}

const config = zoteroConnectorContribution.configSchema;
const collection = (id: string) => ({ id, kind: "collection" });

test("the config schema accepts a user and a group library", () => {
  assert.ok(
    valid(config, { libraryType: "user", libraryId: "12345", items: [] }),
  );
  assert.ok(
    valid(config, {
      libraryType: "group",
      libraryId: "2205533",
      items: [collection("ABCD2345")],
    }),
  );
  assert.ok(valid(config, { libraryType: "user", libraryId: "1" }));
  assert.ok(valid(config, { libraryType: "user", libraryId: "123456789012" }));
});

test("the config schema rejects malformed library and item values", () => {
  const base = { libraryType: "user", libraryId: "12345", items: [] };
  const bad: Record<string, unknown>[] = [
    { ...base, libraryId: "0" },
    { ...base, libraryId: "012" },
    { ...base, libraryId: "12abc" },
    { ...base, libraryId: "1234567890123" },
    { ...base, libraryType: "team" },
    { ...base, items: [collection("ABCD234")] },
    { ...base, items: [collection("abcd2345")] },
    { ...base, items: [{ id: "ABCD2345", kind: "item" }] },
    { ...base, items: [collection("ABCD2345"), collection("ABCD2345")] },
    {
      ...base,
      items: Array.from({ length: 51 }, (_, i) =>
        collection(`ABCD${String(1000 + i)}`),
      ),
    },
    { ...base, extra: true },
    { ...base, items: [{ id: "ABCD2345", kind: "collection", extra: 1 }] },
    { libraryType: "user", items: [] },
    { libraryId: "12345", items: [] },
  ];
  for (const value of bad) {
    assert.equal(valid(config, value), false, JSON.stringify(value));
  }
  const fifty = Array.from({ length: 50 }, (_, i) =>
    collection(`ABCD${String(1000 + i)}`),
  );
  assert.ok(valid(config, { ...base, items: fifty }));
});

test("the config schema holds no credential field and defaults items to empty", () => {
  assert.deepEqual(Object.keys(config.properties).sort(), [
    "items",
    "libraryId",
    "libraryType",
  ]);
  assert.deepEqual([...config.required].sort(), ["libraryId", "libraryType"]);
  assert.equal(config.additionalProperties, false);
  assert.deepEqual(config.properties.items.default, []);
});

test("the browse and describe action inputs are validated", () => {
  const [browse, describe] = zoteroConnectorContribution.actions;
  assert.ok(valid(browse.inputSchema, {}));
  assert.ok(valid(browse.inputSchema, { containerId: null }));
  assert.ok(
    valid(browse.inputSchema, { containerId: "ABCD2345", cursor: "x" }),
  );
  assert.equal(valid(browse.inputSchema, { containerId: "abcd2345" }), false);
  assert.equal(valid(browse.inputSchema, { cursor: "x".repeat(4097) }), false);
  assert.equal(valid(browse.inputSchema, { other: 1 }), false);

  assert.ok(valid(describe.inputSchema, { ids: ["ABCD2345"] }));
  assert.equal(valid(describe.inputSchema, { ids: [] }), false);
  assert.equal(valid(describe.inputSchema, {}), false);
  assert.equal(valid(describe.inputSchema, { ids: ["abcd2345"] }), false);
  assert.equal(
    valid(describe.inputSchema, {
      ids: Array.from({ length: 51 }, () => "ABCD2345"),
    }),
    false,
  );
});

test("limits hold the documented values", () => {
  assert.equal(PAGE_SIZE, 100);
  assert.equal(MAX_OBJECTS, 100_000);
  assert.equal(MAX_REQUESTS, 2_000);
  assert.equal(MAX_RESTARTS, 2);
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(SCAN_TIMEOUT_MS, 900_000);
  assert.equal(MAX_RETRIES, 2);
  assert.equal(MAX_RETRY_DELAY_MS, 10_000);
  assert.equal(MAX_BACKOFF_WAIT_MS, 30_000);
  assert.equal(MAX_RESPONSE_BYTES, 10_485_760);
  assert.equal(MAX_SELECTED_COLLECTIONS, 50);
  assert.equal(SHORTCUT_MAX_AGE_MS, 86_400_000);
  assert.equal(MAX_TEXT_CHARS, 500_000);
});

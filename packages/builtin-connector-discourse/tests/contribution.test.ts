import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_METADATA_AUTHORS,
  MAX_METADATA_POST_IDS,
  MAX_POSTS_PER_TOPIC,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_SELECTED_ITEMS,
  MAX_TEXT_CHARS,
  MAX_TOPICS,
  MAX_TOPICS_PER_CATEGORY,
  MIN_REQUEST_GAP_MS,
  PAGE_SIZE_ASSUMED,
  POST_BATCH,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  discourseConnectorContribution,
} from "../src";

// A minimal JSON Schema subset check, covering exactly the keywords the
// contribution schemas use (type, enum, pattern, min/maxItems, maxLength,
// uniqueItems, items, properties, required, additionalProperties). The
// backend validator ignores minItems/maxLength, so the rules that matter at
// runtime are also expressed through enum, pattern, maxItems, uniqueItems and
// additionalProperties.
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
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return false;
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

const config = discourseConnectorContribution.configSchema;
const item = (id: string, kind: string) => ({ id, kind });
const base = {
  forumUrl: "https://forum.example.com",
  items: [] as unknown[],
  refresh: "light",
};

test("the config schema accepts a bare forum, a subfolder forum and selected items", () => {
  assert.ok(valid(config, base));
  assert.ok(valid(config, { forumUrl: "https://forum.example.com" }));
  assert.ok(
    valid(config, { ...base, forumUrl: "https://example.com/community" }),
  );
  assert.ok(valid(config, { ...base, forumUrl: "https://example.com/a/b/c/" }));
  assert.ok(
    valid(config, {
      ...base,
      items: [item("12", "category"), item("12", "topic"), item("9", "topic")],
      refresh: "deep",
    }),
  );
  assert.ok(valid(config, { ...base, items: [item("1234567890", "topic")] }));
  assert.ok(
    valid(config, {
      ...base,
      items: Array.from({ length: 500 }, (_, i) =>
        item(String(i + 1), "topic"),
      ),
    }),
  );
});

test("the config schema rejects malformed forum URLs", () => {
  const bad = [
    "http://forum.example.com",
    "https://user@forum.example.com",
    "https://user:pw@forum.example.com",
    "https://forum.example.com?x=1",
    "https://forum.example.com/?x=1",
    "https://forum.example.com/c#frag",
    "https://forum.example.com:8443",
    "https://[::1]",
    "https://[::1]/forum",
    "https://forum.example.com/a b",
    "forum.example.com",
    "",
  ];
  for (const forumUrl of bad) {
    assert.equal(valid(config, { ...base, forumUrl }), false, forumUrl);
  }
  assert.equal(valid(config, { items: [], refresh: "light" }), false);
});

test("the config schema rejects malformed items, refresh values and extra keys", () => {
  const bad: Record<string, unknown>[] = [
    { ...base, items: [item("1", "tag")] },
    { ...base, items: [item("0", "topic")] },
    { ...base, items: [item("012", "topic")] },
    { ...base, items: [item("abc", "topic")] },
    { ...base, items: [item("12345678901", "topic")] },
    { ...base, items: [item("", "topic")] },
    { ...base, items: [{ id: "1", kind: "topic", extra: 1 }] },
    { ...base, items: [{ id: "1" }] },
    { ...base, items: [item("1", "topic"), item("1", "topic")] },
    {
      ...base,
      items: Array.from({ length: 501 }, (_, i) =>
        item(String(i + 1), "topic"),
      ),
    },
    { ...base, refresh: "full" },
    { ...base, extra: true },
  ];
  for (const value of bad) {
    assert.equal(valid(config, value), false, JSON.stringify(value));
  }
});

test("the config schema defaults refresh to light and items to empty", () => {
  assert.deepEqual(Object.keys(config.properties).sort(), [
    "forumUrl",
    "items",
    "refresh",
  ]);
  assert.deepEqual([...config.required], ["forumUrl"]);
  assert.equal(config.additionalProperties, false);
  assert.equal(config.properties.refresh.default, "light");
  assert.deepEqual(config.properties.refresh.enum, ["light", "deep"]);
  assert.deepEqual(config.properties.items.default, []);
  assert.equal(config.properties.items.maxItems, 500);
  assert.equal(config.properties.items.uniqueItems, true);
  assert.equal(
    config.properties.forumUrl.pattern,
    "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$",
  );
});

test("the config schema holds no credential field", () => {
  const names = Object.keys(config.properties).join(" ").toLowerCase();
  for (const word of ["key", "token", "secret", "password", "credential"]) {
    assert.equal(names.includes(word), false, word);
  }
});

test("the browse, search and describe action inputs are validated", () => {
  const [browse, search, describe] = discourseConnectorContribution.actions;
  assert.ok(valid(browse.inputSchema, {}));
  assert.ok(valid(browse.inputSchema, { containerId: null }));
  assert.ok(valid(browse.inputSchema, { containerId: "12", cursor: "x" }));
  assert.equal(valid(browse.inputSchema, { containerId: "0" }), false);
  assert.equal(valid(browse.inputSchema, { containerId: "abc" }), false);
  assert.equal(valid(browse.inputSchema, { cursor: "x".repeat(4097) }), false);
  assert.equal(valid(browse.inputSchema, { other: 1 }), false);

  assert.ok(valid(search.inputSchema, { query: "hello" }));
  assert.ok(valid(search.inputSchema, { query: "hello", cursor: "c" }));
  assert.equal(valid(search.inputSchema, {}), false);
  assert.equal(valid(search.inputSchema, { query: "" }), false);
  assert.equal(valid(search.inputSchema, { query: "x".repeat(201) }), false);
  assert.equal(
    valid(search.inputSchema, { query: "a", cursor: "x".repeat(4097) }),
    false,
  );
  assert.equal(valid(search.inputSchema, { query: "a", other: 1 }), false);

  assert.ok(valid(describe.inputSchema, { items: [item("1", "topic")] }));
  assert.equal(valid(describe.inputSchema, { items: [] }), false);
  assert.equal(valid(describe.inputSchema, {}), false);
  assert.equal(
    valid(describe.inputSchema, { items: [item("1", "tag")] }),
    false,
  );
  assert.equal(
    valid(describe.inputSchema, { items: [item("0", "topic")] }),
    false,
  );
  assert.ok(
    valid(describe.inputSchema, {
      items: Array.from({ length: 100 }, (_, i) =>
        item(String(i + 1), "topic"),
      ),
    }),
  );
  assert.equal(
    valid(describe.inputSchema, {
      items: Array.from({ length: 101 }, (_, i) =>
        item(String(i + 1), "topic"),
      ),
    }),
    false,
  );
});

test("limits hold the documented values", () => {
  assert.equal(PAGE_SIZE_ASSUMED, 30);
  assert.equal(MAX_TOPICS_PER_CATEGORY, 2_000);
  assert.equal(MAX_TOPICS, 5_000);
  assert.equal(MAX_REQUESTS, 2_000);
  assert.equal(SCAN_TIMEOUT_MS, 900_000);
  assert.equal(MAX_POSTS_PER_TOPIC, 500);
  assert.equal(POST_BATCH, 20);
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(MAX_RESPONSE_BYTES, 10_485_760);
  assert.equal(MAX_RETRIES, 2);
  assert.equal(MAX_RETRY_DELAY_MS, 30_000);
  assert.equal(MIN_REQUEST_GAP_MS, 150);
  assert.equal(MAX_SELECTED_ITEMS, 500);
  assert.equal(MAX_TEXT_CHARS, 500_000);
  assert.equal(MAX_METADATA_POST_IDS, 500);
  assert.equal(MAX_METADATA_AUTHORS, 100);
});

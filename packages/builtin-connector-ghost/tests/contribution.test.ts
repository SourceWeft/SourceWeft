import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_DEADLINE_MS,
  GHOST_ID_PATTERN,
  GHOST_SITE_URL_PATTERN,
  ID_BATCH,
  MAX_ITEMS,
  MAX_METADATA_TERMS,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_SCAN_RESTARTS,
  MAX_SELECTED_ITEMS,
  MAX_TAG_PAGES,
  MAX_TEXT_CHARS,
  MIN_REQUEST_GAP_MS,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  ghostConnectorContribution,
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

const config = ghostConnectorContribution.configSchema;
const item = (id: string, kind: string) => ({ id, kind });
const base = { siteUrl: "https://example.com", items: [] as unknown[] };
const HEX = "0123456789abcdef01234567";
const HEX2 = "89abcdef0123456789abcdef";

test("the config schema accepts a bare site, a subfolder site and one item of each kind", () => {
  assert.ok(valid(config, base));
  assert.ok(valid(config, { siteUrl: "https://example.com", items: [] }));
  assert.ok(valid(config, { siteUrl: "https://example.com" }));
  assert.ok(valid(config, { ...base, siteUrl: "https://blog.example.com" }));
  assert.ok(valid(config, { ...base, siteUrl: "https://example.com/blog" }));
  assert.ok(valid(config, { ...base, siteUrl: "https://example.com/a/b/" }));
  assert.ok(
    valid(config, {
      ...base,
      items: [
        item("type:post", "type"),
        item("type:page", "type"),
        item(`tag:${HEX}`, "tag"),
        item(`post:${HEX}`, "post"),
        item(`page:${HEX2}`, "page"),
      ],
    }),
  );
  assert.ok(
    valid(config, {
      ...base,
      items: Array.from({ length: 500 }, (_, i) =>
        item(`post:${String(i).padStart(24, "0")}`, "post"),
      ),
    }),
  );
});

test("the config schema rejects malformed site URLs", () => {
  const bad = [
    "http://example.com",
    "https://user@example.com",
    "https://user:pw@example.com",
    "https://example.com?x=1",
    "https://example.com/?x=1",
    "https://example.com/c#frag",
    "https://example.com:8443",
    "https://[::1]",
    "https://[::1]/blog",
    "https://example.com/a b",
    "example.com",
    "",
  ];
  for (const siteUrl of bad) {
    assert.equal(valid(config, { ...base, siteUrl }), false, siteUrl);
  }
  assert.equal(valid(config, { items: [] }), false);
});

test("the config schema rejects malformed items, duplicates, too many items and extra keys", () => {
  const bad: Record<string, unknown>[] = [
    { ...base, items: [item("type:tag", "type")] },
    { ...base, items: [item("type:category", "type")] },
    { ...base, items: [item("post:123", "post")] },
    { ...base, items: [item(`post:${HEX}0`, "post")] },
    { ...base, items: [item(`post:${HEX.slice(1)}`, "post")] },
    { ...base, items: [item(`post:${HEX.toUpperCase()}`, "post")] },
    { ...base, items: [item(`tag:${"g".repeat(24)}`, "tag")] },
    { ...base, items: [item(`Post:${HEX}`, "post")] },
    { ...base, items: [item(`post:${HEX} `, "post")] },
    { ...base, items: [item(HEX, "post")] },
    { ...base, items: [item("", "post")] },
    { ...base, items: [item(`post:${HEX}`, "category")] },
    { ...base, items: [{ id: `post:${HEX}`, kind: "post", extra: 1 }] },
    { ...base, items: [{ id: `post:${HEX}` }] },
    {
      ...base,
      items: [item(`post:${HEX}`, "post"), item(`post:${HEX}`, "post")],
    },
    {
      ...base,
      items: Array.from({ length: 501 }, (_, i) =>
        item(`post:${String(i).padStart(24, "0")}`, "post"),
      ),
    },
    { ...base, extra: true },
  ];
  for (const value of bad) {
    assert.equal(valid(config, value), false, JSON.stringify(value));
  }
});

test("the config schema has the exact shape and holds no credential field", () => {
  assert.deepEqual(Object.keys(config.properties).sort(), ["items", "siteUrl"]);
  assert.deepEqual([...config.required], ["siteUrl"]);
  assert.equal(config.additionalProperties, false);
  assert.deepEqual(config.properties.items.default, []);
  assert.equal(config.properties.items.maxItems, 500);
  assert.equal(config.properties.items.uniqueItems, true);
  assert.equal(
    config.properties.siteUrl.pattern,
    "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$",
  );
  const names = Object.keys(config.properties).join(" ").toLowerCase();
  for (const word of ["key", "token", "secret", "password", "credential"]) {
    assert.equal(names.includes(word), false, word);
  }
  assert.equal(
    GHOST_SITE_URL_PATTERN,
    "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$",
  );
  assert.equal(
    GHOST_ID_PATTERN,
    "^(type:(post|page)|tag:[0-9a-f]{24}|(post|page):[0-9a-f]{24})$",
  );
});

test("the action inputs are validated", () => {
  const [browse, search, describe] = ghostConnectorContribution.actions;
  assert.ok(valid(browse.inputSchema, {}));
  assert.ok(valid(browse.inputSchema, { containerId: null }));
  assert.ok(valid(browse.inputSchema, { cursor: "x" }));
  assert.equal(valid(browse.inputSchema, { containerId: "tag:abc" }), false);
  assert.equal(valid(browse.inputSchema, { cursor: "x".repeat(4097) }), false);
  assert.equal(valid(browse.inputSchema, { other: 1 }), false);

  assert.ok(valid(search.inputSchema, { query: "hello" }));
  assert.ok(valid(search.inputSchema, { query: "hello", cursor: "c" }));
  assert.ok(valid(search.inputSchema, { query: "x".repeat(200) }));
  assert.equal(valid(search.inputSchema, {}), false);
  assert.equal(valid(search.inputSchema, { query: "" }), false);
  assert.equal(valid(search.inputSchema, { query: "x".repeat(201) }), false);
  assert.equal(
    valid(search.inputSchema, { query: "a", cursor: "x".repeat(4097) }),
    false,
  );
  assert.equal(valid(search.inputSchema, { query: "a", other: 1 }), false);

  assert.ok(
    valid(describe.inputSchema, {
      ids: ["type:post", `tag:${HEX}`, `post:${HEX}`, `page:${HEX2}`],
    }),
  );
  assert.equal(valid(describe.inputSchema, { ids: [] }), false);
  assert.equal(valid(describe.inputSchema, {}), false);
  assert.equal(valid(describe.inputSchema, { ids: ["12"] }), false);
  assert.equal(valid(describe.inputSchema, { ids: ["type:tag"] }), false);
  assert.equal(valid(describe.inputSchema, { ids: ["post:1"] }), false);
  assert.equal(
    valid(describe.inputSchema, { ids: [`post:${HEX}`], items: [] }),
    false,
  );
  assert.ok(
    valid(describe.inputSchema, {
      ids: Array.from(
        { length: 100 },
        (_, i) => `post:${String(i).padStart(24, "0")}`,
      ),
    }),
  );
  assert.equal(
    valid(describe.inputSchema, {
      ids: Array.from(
        { length: 101 },
        (_, i) => `post:${String(i).padStart(24, "0")}`,
      ),
    }),
    false,
  );
});

// The schema only fixes the outer shape; the site URL parser (a later task)
// does the semantic checks. This test pins the gap so it stays deliberate.
test("schema accepts shapes that the site URL parser must reject later", () => {
  for (const siteUrl of [
    "https://127.0.0.1",
    "https://2130706433",
    "https://localhost",
    "https://example..com",
    "https://-example.com",
    "https://example.com/a//b",
    "https://example.com/a/../b",
  ]) {
    assert.ok(valid(config, { ...base, siteUrl }), siteUrl);
  }
});

test("limits hold the documented values", () => {
  assert.equal(PAGE_SIZE, 100);
  assert.equal(MAX_ITEMS, 5_000);
  assert.equal(MAX_REQUESTS, 2_000);
  assert.equal(SCAN_TIMEOUT_MS, 900_000);
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(MAX_RESPONSE_BYTES, 10_485_760);
  assert.equal(MAX_RETRIES, 2);
  assert.equal(MAX_RETRY_DELAY_MS, 30_000);
  assert.equal(MIN_REQUEST_GAP_MS, 150);
  assert.equal(MAX_SELECTED_ITEMS, 500);
  assert.equal(MAX_TEXT_CHARS, 500_000);
  assert.equal(MAX_TAG_PAGES, 5);
  assert.equal(MAX_METADATA_TERMS, 50);
  assert.equal(ACTION_DEADLINE_MS, 60_000);
  assert.equal(MAX_SCAN_RESTARTS, 2);
  assert.equal(ID_BATCH, 100);
});

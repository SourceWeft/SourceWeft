import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_DEADLINE_MS,
  HOME_HTML_BYTES,
  MAX_CATEGORY_PAGES,
  MAX_ITEMS,
  MAX_METADATA_TERMS,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_SCAN_RESTARTS,
  MAX_SELECTED_ITEMS,
  MAX_TAG_IDS,
  MAX_TEXT_CHARS,
  MIN_REQUEST_GAP_MS,
  PER_PAGE,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  WORDPRESS_ID_PATTERN,
  WORDPRESS_SITE_URL_PATTERN,
  wordpressConnectorContribution,
  wordpressLoginConnectorContribution,
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

const publicConfig = wordpressConnectorContribution.configSchema;
const loginConfig = wordpressLoginConnectorContribution.configSchema;
const item = (id: string, kind: string) => ({ id, kind });
const base = { siteUrl: "https://example.com", items: [] as unknown[] };
const schemas = [
  ["wordpress", publicConfig],
  ["wordpress_login", loginConfig],
] as const;

test("both config schemas accept a bare site, a subfolder site and one item of each kind", () => {
  for (const [name, config] of schemas) {
    assert.ok(valid(config, base), name);
    assert.ok(valid(config, { ...base, siteUrl: "https://blog.example.com" }));
    assert.ok(valid(config, { ...base, siteUrl: "https://example.com/blog" }));
    assert.ok(valid(config, { ...base, siteUrl: "https://example.com/a/b/" }));
    assert.ok(
      valid(config, {
        ...base,
        items: [
          item("type:post", "type"),
          item("type:page", "type"),
          item("category:3", "category"),
          item("post:9", "post"),
          item("page:9", "page"),
        ],
      }),
      name,
    );
    assert.ok(
      valid(config, { ...base, items: [item("post:1234567890", "post")] }),
    );
    assert.ok(
      valid(config, {
        ...base,
        items: Array.from({ length: 500 }, (_, i) =>
          item(`post:${i + 1}`, "post"),
        ),
      }),
    );
  }
});

test("both config schemas reject malformed site URLs", () => {
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
  for (const [name, config] of schemas) {
    for (const siteUrl of bad) {
      assert.equal(
        valid(config, { ...base, siteUrl }),
        false,
        `${name} ${siteUrl}`,
      );
    }
    assert.equal(valid(config, { items: [] }), false, name);
  }
});

test("both config schemas reject malformed items and extra keys", () => {
  const bad: Record<string, unknown>[] = [
    { ...base, items: [item("type:tag", "type")] },
    { ...base, items: [item("tag:3", "tag")] },
    { ...base, items: [item("post:0", "post")] },
    { ...base, items: [item("post:012", "post")] },
    { ...base, items: [item("post:", "post")] },
    { ...base, items: [item("post:12345678901", "post")] },
    { ...base, items: [item("category:0", "category")] },
    { ...base, items: [item("type:category", "type")] },
    { ...base, items: [item("9", "post")] },
    { ...base, items: [item("", "post")] },
    { ...base, items: [item("Post:1", "post")] },
    { ...base, items: [item("post:1 ", "post")] },
    { ...base, items: [item("post:1", "tag")] },
    { ...base, items: [{ id: "post:1", kind: "post", extra: 1 }] },
    { ...base, items: [{ id: "post:1" }] },
    { ...base, items: [item("post:1", "post"), item("post:1", "post")] },
    {
      ...base,
      items: Array.from({ length: 501 }, (_, i) =>
        item(`post:${i + 1}`, "post"),
      ),
    },
    { ...base, extra: true },
  ];
  for (const [name, config] of schemas) {
    for (const value of bad) {
      assert.equal(
        valid(config, value),
        false,
        `${name} ${JSON.stringify(value)}`,
      );
    }
  }
});

test("includeUnpublished exists only on the login schema", () => {
  assert.equal(
    valid(publicConfig, { ...base, includeUnpublished: false }),
    false,
  );
  assert.equal(
    valid(publicConfig, { ...base, includeUnpublished: true }),
    false,
  );
  assert.ok(valid(loginConfig, { ...base, includeUnpublished: true }));
  assert.ok(valid(loginConfig, { ...base, includeUnpublished: false }));
  assert.equal(
    valid(loginConfig, { ...base, includeUnpublished: "yes" }),
    false,
  );
  assert.equal(loginConfig.properties.includeUnpublished.default, false);
});

test("the config schemas have the exact shape and hold no credential field", () => {
  assert.deepEqual(Object.keys(publicConfig.properties).sort(), [
    "items",
    "siteUrl",
  ]);
  assert.deepEqual(Object.keys(loginConfig.properties).sort(), [
    "includeUnpublished",
    "items",
    "siteUrl",
  ]);
  for (const [name, config] of schemas) {
    assert.deepEqual([...config.required], ["siteUrl"], name);
    assert.equal(config.additionalProperties, false, name);
    assert.deepEqual(config.properties.items.default, [], name);
    assert.equal(config.properties.items.maxItems, 500, name);
    assert.equal(config.properties.items.uniqueItems, true, name);
    assert.equal(
      config.properties.siteUrl.pattern,
      "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$",
      name,
    );
    const names = Object.keys(config.properties).join(" ").toLowerCase();
    for (const word of ["key", "token", "secret", "password", "credential"]) {
      assert.equal(names.includes(word), false, `${name} ${word}`);
    }
  }
  assert.equal(
    WORDPRESS_SITE_URL_PATTERN,
    "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$",
  );
  assert.equal(
    WORDPRESS_ID_PATTERN,
    "^(type:(post|page)|(category|post|page):[1-9][0-9]{0,9})$",
  );
});

test("the action inputs are validated for both connectors", () => {
  for (const contribution of [
    wordpressConnectorContribution,
    wordpressLoginConnectorContribution,
  ]) {
    const [browse, search, describe] = contribution.actions;
    assert.ok(valid(browse.inputSchema, {}));
    assert.ok(valid(browse.inputSchema, { containerId: null }));
    assert.ok(valid(browse.inputSchema, { containerId: "category:5" }));
    assert.ok(
      valid(browse.inputSchema, { containerId: "category:12", cursor: "x" }),
    );
    assert.equal(
      valid(browse.inputSchema, { containerId: "type:post" }),
      false,
    );
    assert.equal(valid(browse.inputSchema, { containerId: "post:5" }), false);
    assert.equal(valid(browse.inputSchema, { containerId: "5" }), false);
    assert.equal(
      valid(browse.inputSchema, { containerId: "category:0" }),
      false,
    );
    assert.equal(
      valid(browse.inputSchema, { cursor: "x".repeat(4097) }),
      false,
    );
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

    assert.ok(
      valid(describe.inputSchema, {
        ids: ["type:post", "category:2", "post:3", "page:4"],
      }),
    );
    assert.equal(valid(describe.inputSchema, { ids: [] }), false);
    assert.equal(valid(describe.inputSchema, {}), false);
    assert.equal(valid(describe.inputSchema, { ids: ["12"] }), false);
    assert.equal(valid(describe.inputSchema, { ids: ["type:tag"] }), false);
    assert.equal(valid(describe.inputSchema, { ids: ["post:0"] }), false);
    assert.equal(
      valid(describe.inputSchema, { ids: ["post:1"], items: [] }),
      false,
    );
    assert.ok(
      valid(describe.inputSchema, {
        ids: Array.from({ length: 100 }, (_, i) => `post:${i + 1}`),
      }),
    );
    assert.equal(
      valid(describe.inputSchema, {
        ids: Array.from({ length: 101 }, (_, i) => `post:${i + 1}`),
      }),
      false,
    );
  }
});

// The schema only fixes the outer shape; the site URL parser (a later task)
// does the semantic checks. This test pins the gap so it stays deliberate.
test("schema accepts shapes that the site URL parser must reject later", () => {
  for (const siteUrl of [
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f.1",
    "https://localhost",
    "https://example..com",
    "https://-example.com",
    "https://example.com/a//b",
    "https://example.com/a/../b",
    "https://example.com/./a",
  ]) {
    for (const [name, config] of schemas) {
      assert.ok(valid(config, { ...base, siteUrl }), `${name} ${siteUrl}`);
    }
  }
});

test("limits hold the documented values", () => {
  assert.equal(PER_PAGE, 100);
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
  assert.equal(MAX_CATEGORY_PAGES, 20);
  assert.equal(MAX_TAG_IDS, 2_000);
  assert.equal(MAX_METADATA_TERMS, 50);
  assert.equal(ACTION_DEADLINE_MS, 60_000);
  assert.equal(HOME_HTML_BYTES, 262_144);
  assert.equal(MAX_SCAN_RESTARTS, 2);
});

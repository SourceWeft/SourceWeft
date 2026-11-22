import assert from "node:assert/strict";
import test from "node:test";
import {
  checkConnectorConfigRequestSchema,
  checkConnectorConfigResponseSchema,
} from "../src/connectors";

test("check request accepts a connector type and a config object", () => {
  const parsed = checkConnectorConfigRequestSchema.parse({
    connectorType: " rss ",
    configJson: { feedUrl: "https://example.com/feed.xml" },
  });
  assert.equal(parsed.connectorType, "rss");
  assert.deepEqual(parsed.configJson, { feedUrl: "https://example.com/feed.xml" });
});

test("check request rejects an empty connector type or a missing config", () => {
  assert.equal(
    checkConnectorConfigRequestSchema.safeParse({
      connectorType: "  ",
      configJson: {},
    }).success,
    false,
  );
  assert.equal(
    checkConnectorConfigRequestSchema.safeParse({ connectorType: "rss" })
      .success,
    false,
  );
});

test("check response parses ready and not-ready results", () => {
  assert.deepEqual(
    checkConnectorConfigResponseSchema.parse({
      ready: false,
      reason: "feed_timeout",
    }),
    { ready: false, reason: "feed_timeout" },
  );
  assert.equal(
    checkConnectorConfigResponseSchema.parse({
      ready: true,
      metadata: { title: "Feed" },
    }).ready,
    true,
  );
  assert.equal(
    checkConnectorConfigResponseSchema.safeParse({ reason: "x" }).success,
    false,
  );
});

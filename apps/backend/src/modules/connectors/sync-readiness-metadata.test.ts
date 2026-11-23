import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SYNC_READINESS_CONFIG_KEY,
  hasSyncReadinessMetadata,
  withSyncReadinessMetadata,
  withoutSyncReadinessMetadata,
} from "./sync-readiness-metadata";

describe("sync readiness metadata", () => {
  test("the key is the stored config key", () => {
    assert.equal(SYNC_READINESS_CONFIG_KEY, "syncReadiness");
  });

  test("withoutSyncReadinessMetadata strips only the platform key", () => {
    const config = {
      feedUrl: "https://example.com/feed.xml",
      syncReadiness: { ready: false, reason: "feed_timeout" },
    };
    assert.deepEqual(withoutSyncReadinessMetadata(config), {
      feedUrl: "https://example.com/feed.xml",
    });
    assert.ok("syncReadiness" in config, "input is not mutated");
  });

  test("a config without the key is returned as is", () => {
    const config = { feedUrl: "https://example.com/feed.xml" };
    assert.equal(withoutSyncReadinessMetadata(config), config);
    assert.equal(hasSyncReadinessMetadata(config), false);
  });

  test("with and without round-trip back to the original config", () => {
    const config = { feedUrl: "https://example.com/feed.xml" };
    const marked = withSyncReadinessMetadata(config, {
      ready: false,
      reason: "feed_timeout",
    });
    assert.equal(hasSyncReadinessMetadata(marked), true);
    assert.deepEqual(withoutSyncReadinessMetadata(marked), config);
  });
});

import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { item, makeSetup, PAGE_CHARS } from "./sync-test-support";

let schema: typeof import("@sourceweft/db");
let connectorRuntime: typeof import("./index");
let syncRunRepo: typeof import("./repository/sync-run");
let indexing: typeof import("../sources/indexing-service");
let setup: ReturnType<typeof makeSetup>;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_counts");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRuntime = await import("./index");
  syncRunRepo = await import("./repository/sync-run");
  indexing = await import("../sources/indexing-service");
  setup = makeSetup({ schema, connectorRuntime, syncRunRepo, indexing });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

type RunCounts = {
  updatedCount?: unknown;
  unchangedCount?: unknown;
  skippedCount?: unknown;
};

function counts(run: { metadataJson: unknown }) {
  const { updatedCount, unchangedCount, skippedCount } =
    run.metadataJson as RunCounts;
  return { updatedCount, unchangedCount, skippedCount };
}

test("a first run counts every indexed item as new and a declined item as skipped", async () => {
  const t = await setup({
    pagesOf: [
      [
        item("a"),
        item("b"),
        item("declined", 0, {
          extractShape: { mode: "skip", reason: "unsupported_type" },
        }),
      ],
    ],
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.discoveredCount, 3);
  assert.equal(run.indexedCount, 2);
  assert.deepEqual(counts(run), {
    updatedCount: 0,
    unchangedCount: 0,
    skippedCount: 1,
  });
});

test("a second run separates changed, unchanged and skipped items", async () => {
  const changed = item("changed");
  const same = item("same");
  const declined = item("declined", 0, {
    extractShape: { mode: "skip", reason: "unsupported_type" },
  });
  const t = await setup({ pagesOf: [[changed, same, declined]] });
  const first = await t.sync();
  assert.equal(first.status, "succeeded");
  assert.equal(first.indexedCount, 2);

  changed.externalUpdatedAt = new Date("2026-10-01T00:00:00.000Z");
  changed.body = "y".repeat(24);
  const second = await t.sync();
  assert.equal(second.status, "succeeded");
  assert.equal(second.discoveredCount, 3);
  // Indexed includes the changed item; it is also the only update.
  assert.equal(second.indexedCount, 1);
  assert.deepEqual(counts(second), {
    updatedCount: 1,
    unchangedCount: 1,
    skippedCount: 1,
  });
});

test("an item too large for the cycle allowance counts as skipped", async () => {
  const t = await setup({
    pagesOf: [[item("huge", PAGE_CHARS * 6), item("small")]],
    billing: { available: 5, cycleCapacity: 5 },
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.indexedCount, 1);
  assert.deepEqual(counts(run), {
    updatedCount: 0,
    unchangedCount: 0,
    skippedCount: 1,
  });
});

test("the sync activity summary carries the counts and leaves older runs null", async () => {
  const { toSyncActivityItem } = await import("./repository/activity");
  const { mapSyncRun } = await import("./mappers");
  const t = await setup({ pagesOf: [[item("a")]] });
  const run = await t.sync();
  const summary = toSyncActivityItem(mapSyncRun(run)).summaryJson;
  assert.equal(summary.updatedCount, 0);
  assert.equal(summary.unchangedCount, 0);
  assert.equal(summary.skippedCount, 0);

  const legacy = toSyncActivityItem(
    mapSyncRun({ ...run, metadataJson: {} }),
  ).summaryJson;
  assert.equal(legacy.updatedCount, null);
  assert.equal(legacy.unchangedCount, null);
  assert.equal(legacy.skippedCount, null);
});

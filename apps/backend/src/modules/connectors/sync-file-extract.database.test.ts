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
  isolated = await createIsolatedTestDatabase("connector_file");
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

/** A file-shaped item whose download returns `body` as a plain-text buffer, so
 * the real text parser turns it into the indexed content. */
function fileItem(
  externalId: string,
  body: string,
  overrides: { title?: string; contentHash?: string | null } = {},
) {
  return item(externalId, 0, {
    body,
    extractShape: {
      mode: "file",
      fileName: `${externalId}.txt`,
      fileMimeType: "text/plain",
    },
    ...overrides,
  });
}

test("indexes a file-shaped item through the parser", async () => {
  const t = await setup({ pagesOf: [[fileItem("f1", "alpha beta")]] });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.indexedCount, 1);
  const [row] = await t.sourceRows();
  assert.ok(row?.contentText.includes("alpha beta"));
  assert.equal(row?.status, "indexed");
});

test("keeps connectorType and parentExternalId authoritative over parser metadata", async () => {
  const t = await setup({ pagesOf: [[fileItem("f1", "alpha beta")]] });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  const [row] = await t.sourceRows();
  const metadata = row?.metadataJson as Record<string, unknown>;
  assert.equal(metadata.connectorType, "fake_quota");
  assert.equal(metadata.parentExternalId, null);
  assert.equal(row?.mimeType, "text/plain");
  // A key the real text parser emits survives the merge ("alpha beta" = 10 chars).
  assert.equal(metadata.charCount, 10);
});

test("records a skipped item without failing the run", async () => {
  const t = await setup({
    pagesOf: [
      [
        item("s1", 0, {
          title: "Skipped doc",
          extractShape: { mode: "skip", reason: "unsupported_type" },
        }),
      ],
    ],
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.failedCount, 0);
  assert.equal(run.indexedCount, 0);
  assert.deepEqual(
    (run.metadataJson as { skippedItems?: unknown[] }).skippedItems,
    [{ externalId: "s1", title: "Skipped doc", reason: "unsupported_type" }],
  );
  assert.equal((await t.sourceRows()).length, 0);
});

test("keeps an already-indexed source when its item is skipped in a reconciling scan", async () => {
  const docItem = fileItem("doc", "gamma delta");
  const t = await setup({ pagesOf: [[docItem]], reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  // The same item is unresolvable on the next scan. Bump its watermark so the
  // run re-extracts it (rather than treating it as unchanged) and then skips it.
  docItem.extractShape = { mode: "skip", reason: "unsupported_type" };
  docItem.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "indexed");
});

test("skips extraction when the content hash is unchanged", async () => {
  const t = await setup({
    pagesOf: [[fileItem("h1", "epsilon", { contentHash: "md5:abc" })]],
  });
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal(t.fake.extract.mock.calls.length, 1);
  assert.equal(t.index.calls.length, 1);

  assert.equal((await t.sync()).status, "succeeded");
  // Same hash: the second scan neither re-extracts nor re-indexes.
  assert.equal(t.fake.extract.mock.calls.length, 1);
  assert.equal(t.index.calls.length, 1);
});

test("updates the title of an unchanged item without re-indexing", async () => {
  const titled = fileItem("t1", "zeta", {
    title: "First title",
    contentHash: "md5:xyz",
  });
  const t = await setup({ pagesOf: [[titled]] });
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal(t.index.calls.length, 1);

  titled.title = "Second title";
  assert.equal((await t.sync()).status, "succeeded");
  const [row] = await t.sourceRows();
  assert.equal(row?.title, "Second title");
  assert.equal(t.index.calls.length, 1);
});

test("blocks at per-item admission when a file-shaped item needs more pages than remain", async () => {
  // One page left and a file whose parsed text is over 4,000 chars (2 pages):
  // the opening admission of 1 page passes, extract runs, and the per-item
  // admission is what blocks — not the opening check.
  const t = await setup({
    pagesOf: [[fileItem("f1", "a".repeat(PAGE_CHARS + 1))]],
    billing: { available: 1 },
  });
  const run = await t.sync();
  assert.equal(run.status, "blocked");
  assert.equal(run.errorCode, "PAGES_LIMIT_EXCEEDED");
  assert.equal(t.fake.extract.mock.calls.length, 1);
  assert.equal((await t.sourceRows()).length, 0);
});

test("records an empty file-shaped item as an empty_content skip", async () => {
  const t = await setup({
    pagesOf: [[fileItem("blank", "   \n  ")]],
  });
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.failedCount, 0);
  assert.deepEqual(
    (run.metadataJson as { skippedItems?: unknown[] }).skippedItems,
    [{ externalId: "blank", title: "blank", reason: "empty_content" }],
  );
  assert.equal((await t.sourceRows()).length, 0);
});

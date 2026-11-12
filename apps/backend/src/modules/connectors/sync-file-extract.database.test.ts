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

test("archives an already-indexed source when its item is later skipped", async () => {
  const docItem = fileItem("doc", "gamma delta");
  const t = await setup({ pagesOf: [[docItem]], reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  // The same item is unresolvable on the next scan. Bump its watermark so the
  // run re-extracts it (rather than treating it as unchanged) and then skips it.
  docItem.extractShape = { mode: "skip", reason: "unsupported_type" };
  docItem.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.failedCount, 0);
  assert.deepEqual(
    (run.metadataJson as { skippedItems?: unknown[] }).skippedItems,
    [{ externalId: "doc", title: "doc", reason: "unsupported_type" }],
  );
  // The stale indexed content must not stay searchable: archive it.
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "archived");
});

test("archives a skipped existing source on a scan that does not reconcile", async () => {
  const docItem = fileItem("doc", "gamma delta");
  const t = await setup({ pagesOf: [[docItem]] });
  assert.equal((await t.sync()).status, "succeeded");

  // Archiving happens in finishSkippedItem itself, so it does not wait for a
  // reconciling scan: this adapter never reconciles.
  docItem.extractShape = { mode: "skip", reason: "unsupported_type" };
  docItem.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "archived");
});

test("re-indexes an archived source when its item becomes indexable again", async () => {
  const docItem = fileItem("doc", "gamma delta");
  const t = await setup({ pagesOf: [[docItem]], reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  // Run 2 skips the item, so its source is archived.
  docItem.extractShape = { mode: "skip", reason: "unsupported_type" };
  docItem.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal((await t.sourceRows())[0]?.status, "archived");

  // Run 3: the item is readable again with new content. shouldSkipExtract
  // refuses to skip a non-indexed source, so the existing path re-extracts,
  // re-indexes, and brings the archived source back to indexed.
  const indexCallsBeforeRecovery = t.index.calls.length;
  docItem.extractShape = {
    mode: "file",
    fileName: "doc.txt",
    fileMimeType: "text/plain",
  };
  docItem.body = "omega recovered";
  docItem.externalUpdatedAt = new Date("2026-09-03T00:00:00.000Z");
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.indexedCount, 1);
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "indexed");
  assert.ok(row?.contentText.includes("omega recovered"));
  assert.equal(t.index.calls.length, indexCallsBeforeRecovery + 1);
});

test("re-indexes a source archived as deleted when its item is discovered again", async () => {
  // A text item archived through the reconcile/deleted path (not by skip) must
  // also come back when the same externalId is discovered again.
  const delItem = item("del", 20);
  const pagesOf = [[delItem]];
  const t = await setup({ pagesOf, reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal((await t.sourceRows())[0]?.status, "indexed");

  // Run 2: the item is no longer discovered, so the reconciling scan archives it.
  pagesOf[0] = [];
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal((await t.sourceRows())[0]?.status, "archived");

  // Run 3: the same externalId is discovered again and is revived in place.
  pagesOf[0] = [delItem];
  const indexBefore = t.index.calls.length;
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.failedCount, 0);
  assert.equal(run.indexedCount, 1);
  const rows = (await t.sourceRows()).filter((r) => r.externalId === "del");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "indexed");
  assert.equal(t.index.calls.length, indexBefore + 1);
});

test("revives an archived source with unchanged content without skipping extraction", async () => {
  const docItem = item("same", 20);
  const pagesOf = [[docItem]];
  const t = await setup({ pagesOf, reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  // Archive it through the reconcile path.
  pagesOf[0] = [];
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal((await t.sourceRows())[0]?.status, "archived");

  // Run 3 rediscovers the same, unchanged content. An archived row never takes
  // the "same hash, do not re-index" shortcut, so extract runs and it re-indexes.
  pagesOf[0] = [docItem];
  const extractBefore = t.fake.extract.mock.calls.length;
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "indexed");
  assert.equal(t.fake.extract.mock.calls.length, extractBefore + 1);
});

test("keeps an archived source archived when its item is skipped again", async () => {
  const docItem = fileItem("doc", "gamma delta");
  const t = await setup({ pagesOf: [[docItem]], reconcile: true });
  assert.equal((await t.sync()).status, "succeeded");

  // Run 2 skips the item, so its source is archived.
  docItem.extractShape = { mode: "skip", reason: "unsupported_type" };
  docItem.externalUpdatedAt = new Date("2026-09-02T00:00:00.000Z");
  assert.equal((await t.sync()).status, "succeeded");
  assert.equal((await t.sourceRows())[0]?.status, "archived");

  // Run 3: still unreadable and skipped again — the archived row is left as is.
  docItem.externalUpdatedAt = new Date("2026-09-03T00:00:00.000Z");
  const run = await t.sync();
  assert.equal(run.status, "succeeded");
  assert.equal(run.failedCount, 0);
  assert.deepEqual(
    (run.metadataJson as { skippedItems?: unknown[] }).skippedItems,
    [{ externalId: "doc", title: "doc", reason: "unsupported_type" }],
  );
  const [row] = await t.sourceRows();
  assert.equal(row?.status, "archived");
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

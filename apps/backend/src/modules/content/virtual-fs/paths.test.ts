import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildChunkFilePath,
  buildVirtualSource,
  buildVirtualSourceTree,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
  safeVirtualName,
} from "./paths";

function source(
  overrides: Partial<Parameters<typeof buildVirtualSource>[0]> = {},
) {
  return buildVirtualSource({
    sourceId: "source-1234567890",
    title: "Quarterly Report",
    fileName: "Quarterly Report.pdf",
    chunkCount: 3,
    sizeBytes: 1024,
    mimeType: "application/pdf",
    updatedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  });
}

test("normalizeVirtualPath defaults to /kb and normalizes slashes", () => {
  assert.equal(normalizeVirtualPath(undefined), "/kb");
  assert.equal(normalizeVirtualPath(""), "/kb");
  assert.equal(
    normalizeVirtualPath("kb//source///chunks/"),
    "/kb/source/chunks",
  );
  assert.equal(normalizeVirtualPath("/"), "/");
});

test("normalizeVirtualPath rejects traversal and non-kb paths", () => {
  assert.throws(() => normalizeVirtualPath("/kb/../secret"), /EINVAL/);
  assert.throws(() => normalizeVirtualPath("~/secret"), /EINVAL/);
  assert.throws(() => normalizeVirtualPath("/tmp/file"), /ENOENT/);
});

test("safeVirtualName strips extensions and sanitizes unsafe characters", () => {
  assert.equal(
    safeVirtualName("Quarterly Report.pdf", "fallback-id"),
    "Quarterly-Report",
  );
  assert.equal(
    safeVirtualName("  ACME: Invoice #42!!.md  ", "fallback-id"),
    "ACME-Invoice-42",
  );
  assert.equal(safeVirtualName("!!!", "fallback-id"), "fallback-id");
});

test("buildVirtualSource creates stable source and directory paths", () => {
  const item = source();

  assert.equal(item.safeName, "Quarterly-Report");
  assert.equal(item.shortId, "source-1");
  assert.equal(item.filePath, "/kb/Quarterly-Report__src_source-1.md");
  assert.equal(item.dirPath, "/kb/Quarterly-Report__src_source-1");
  assert.equal(item.readmePath, null);
});

test("buildVirtualSource creates plain directory paths without id suffixes", () => {
  const item = source({
    sourceType: "directory",
    title: "Design",
    fileName: null,
    chunkCount: 0,
  });

  assert.equal(item.safeName, "Design");
  assert.equal(item.filePath, null);
  assert.equal(item.dirPath, "/kb/Design");
  assert.equal(item.readmePath, "/kb/Design/README.md");
});

test("buildVirtualSourceTree nests sources under directory paths", () => {
  const items = buildVirtualSourceTree([
    {
      sourceId: "dir-1234567890",
      sourceType: "directory",
      parentSourceId: null,
      title: "Design",
      fileName: null,
      chunkCount: 0,
      sizeBytes: null,
      mimeType: null,
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    {
      sourceId: "source-1234567890",
      sourceType: "manual_upload",
      parentSourceId: "dir-1234567890",
      title: "Design System",
      fileName: "Design System.md",
      chunkCount: 1,
      sizeBytes: null,
      mimeType: "text/markdown",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
  ]);

  assert.equal(items[0]?.dirPath, "/kb/Design");
  assert.equal(items[1]?.filePath, "/kb/Design/Design-System__src_source-1.md");
});

test("buildVirtualSourceTree projects Notion connector directories into nested kb paths", () => {
  const items = buildVirtualSourceTree([
    {
      sourceId: "notion-root-123456",
      sourceType: "directory",
      parentSourceId: null,
      title: "Notion",
      fileName: null,
      chunkCount: 0,
      sizeBytes: null,
      mimeType: "inode/directory",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    {
      sourceId: "tasks-dir-123456",
      sourceType: "directory",
      parentSourceId: "notion-root-123456",
      title: "Tasks",
      fileName: null,
      chunkCount: 0,
      sizeBytes: null,
      mimeType: "inode/directory",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    {
      sourceId: "projects-dir-123456",
      sourceType: "directory",
      parentSourceId: "tasks-dir-123456",
      title: "Projects & Tasks",
      fileName: null,
      chunkCount: 0,
      sizeBytes: null,
      mimeType: "inode/directory",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    {
      sourceId: "source-abcdef1234",
      sourceType: "connector",
      parentSourceId: "projects-dir-123456",
      title: "KW: instagram photo scraper",
      fileName: null,
      chunkCount: 1,
      sizeBytes: null,
      mimeType: "text/markdown",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
  ]);

  assert.equal(items[0]?.dirPath, "/kb/Notion");
  assert.equal(items[1]?.dirPath, "/kb/Notion/Tasks");
  assert.equal(items[2]?.dirPath, "/kb/Notion/Tasks/Projects-Tasks");
  assert.equal(
    items[3]?.filePath,
    "/kb/Notion/Tasks/Projects-Tasks/KW-instagram-photo-scraper__src_source-a.md",
  );
});

test("buildChunkFilePath pads chunk numbers under the chunks directory", () => {
  const item = source();

  assert.equal(
    buildChunkFilePath(item, 0),
    "/kb/Quarterly-Report__src_source-1/chunks/0000.md",
  );
  assert.equal(
    buildChunkFilePath(item, 42),
    "/kb/Quarterly-Report__src_source-1/chunks/0042.md",
  );
});

test("parseVirtualPath resolves root, kb root, source, chunks dir, and chunk file", () => {
  const item = source();
  const sources = [item];

  assert.deepEqual(parseVirtualPath("/", sources), { kind: "root" });
  assert.deepEqual(parseVirtualPath("/kb", sources), { kind: "kbRoot" });
  assert.deepEqual(parseVirtualPath(item.filePath!, sources), {
    kind: "sourceFile",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(`${item.dirPath}/chunks`, sources), {
    kind: "sourceChunksDir",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(buildChunkFilePath(item, 2), sources), {
    kind: "chunkFile",
    sourceId: item.sourceId,
    chunkNo: 2,
  });
});

test("parseVirtualPath resolves library directories and readmes", () => {
  const item = source({
    sourceType: "directory",
    title: "Design",
    fileName: null,
    chunkCount: 0,
  });

  assert.deepEqual(parseVirtualPath(item.dirPath, [item]), {
    kind: "libraryDirectory",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(item.readmePath!, [item]), {
    kind: "libraryDirectoryReadme",
    sourceId: item.sourceId,
  });
});

test("parseVirtualPath rejects unknown sources and malformed chunk files", () => {
  const item = source();

  assert.throws(() => parseVirtualPath("/kb/missing.md", [item]), /ENOENT/);
  assert.throws(
    () => parseVirtualPath(`${item.dirPath}/chunks/current.txt`, [item]),
    /ENOENT/,
  );
});

test("findVirtualSource returns visible source or reports scoped miss", () => {
  const item = source();

  assert.equal(findVirtualSource([item], item.sourceId), item);
  assert.throws(
    () => findVirtualSource([item], "other-source"),
    /not visible in \/kb/,
  );
});

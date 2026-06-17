import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChunkFilePath,
  buildVirtualSource,
  buildVirtualSourceTree,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
  safeVirtualName,
} from "../src/index";

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

test("paths.normalizeVirtualPath anchors and validates /kb", () => {
  assert.equal(normalizeVirtualPath(undefined), "/kb");
  assert.equal(normalizeVirtualPath("kb//source///chunks/"), "/kb/source/chunks");
  assert.equal(normalizeVirtualPath("/"), "/");
  assert.throws(() => normalizeVirtualPath("/kb/../secret"), /EINVAL/);
  assert.throws(() => normalizeVirtualPath("/tmp/file"), /ENOENT/);
});

test("paths.buildVirtualSourceTree creates stable nested source paths", () => {
  const items = buildVirtualSourceTree([
    {
      sourceId: "dir-1234567890",
      sourceType: "directory",
      parentSourceId: null,
      title: "Design",
      fileName: null,
      chunkCount: 0,
      sizeBytes: null,
      mimeType: "inode/directory",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    {
      sourceId: "source-abcdef1234",
      sourceType: "connector",
      parentSourceId: "dir-1234567890",
      title: "Project Notes",
      fileName: null,
      chunkCount: 1,
      sizeBytes: null,
      mimeType: "text/markdown",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
  ]);

  assert.equal(items[0]?.dirPath, "/kb/Design");
  assert.equal(items[1]?.filePath, "/kb/Design/Project-Notes__src_source-a.md");
});

test("paths.parseVirtualPath resolves files chunks and directory readmes", () => {
  const file = source();
  const directory = source({
    sourceId: "dir-1234567890",
    sourceType: "directory",
    title: "Design",
    fileName: null,
    chunkCount: 0,
  });

  assert.deepEqual(parseVirtualPath("/", [file]), { kind: "root" });
  assert.deepEqual(parseVirtualPath("/kb", [file]), { kind: "kbRoot" });
  assert.deepEqual(parseVirtualPath(file.filePath ?? "", [file]), {
    kind: "sourceFile",
    sourceId: file.sourceId,
  });
  assert.deepEqual(parseVirtualPath(buildChunkFilePath(file, 2), [file]), {
    kind: "chunkFile",
    sourceId: file.sourceId,
    chunkNo: 2,
  });
  assert.deepEqual(parseVirtualPath(directory.readmePath ?? "", [directory]), {
    kind: "libraryDirectoryReadme",
    sourceId: directory.sourceId,
  });
});

test("paths.safeVirtualName and findVirtualSource preserve existing behavior", () => {
  const item = source();

  assert.equal(safeVirtualName("ACME: Invoice #42!!.md", "fallback-id"), "ACME-Invoice-42");
  assert.equal(findVirtualSource([item], item.sourceId), item);
  assert.throws(
    () => findVirtualSource([item], "other-source"),
    /not visible in \/kb/,
  );
});

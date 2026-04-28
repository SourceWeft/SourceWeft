import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChunkFilePath,
  buildVirtualSource,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
  safeVirtualName,
} from "./paths";

function source(overrides: Partial<Parameters<typeof buildVirtualSource>[0]> = {}) {
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
  assert.equal(normalizeVirtualPath("kb//source///chunks/"), "/kb/source/chunks");
  assert.equal(normalizeVirtualPath("/"), "/");
});

test("normalizeVirtualPath rejects traversal and non-kb paths", () => {
  assert.throws(() => normalizeVirtualPath("/kb/../secret"), /EINVAL/);
  assert.throws(() => normalizeVirtualPath("~/secret"), /EINVAL/);
  assert.throws(() => normalizeVirtualPath("/tmp/file"), /ENOENT/);
});

test("safeVirtualName strips extensions and sanitizes unsafe characters", () => {
  assert.equal(safeVirtualName("Quarterly Report.pdf", "fallback-id"), "Quarterly-Report");
  assert.equal(safeVirtualName("  ACME: Invoice #42!!.md  ", "fallback-id"), "ACME-Invoice-42");
  assert.equal(safeVirtualName("!!!", "fallback-id"), "fallback-id");
});

test("buildVirtualSource creates stable source and directory paths", () => {
  const item = source();

  assert.equal(item.safeName, "Quarterly-Report");
  assert.equal(item.shortId, "source-1");
  assert.equal(item.filePath, "/kb/Quarterly-Report__src_source-1.md");
  assert.equal(item.dirPath, "/kb/Quarterly-Report__src_source-1");
});

test("buildChunkFilePath pads chunk numbers under the chunks directory", () => {
  const item = source();

  assert.equal(buildChunkFilePath(item, 0), "/kb/Quarterly-Report__src_source-1/chunks/0000.md");
  assert.equal(buildChunkFilePath(item, 42), "/kb/Quarterly-Report__src_source-1/chunks/0042.md");
});

test("parseVirtualPath resolves root, kb root, source, chunks dir, and chunk file", () => {
  const item = source();
  const sources = [item];

  assert.deepEqual(parseVirtualPath("/", sources), { kind: "root" });
  assert.deepEqual(parseVirtualPath("/kb", sources), { kind: "kbRoot" });
  assert.deepEqual(parseVirtualPath(item.filePath, sources), {
    kind: "sourceFile",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(item.dirPath, sources), {
    kind: "sourceDir",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(`${item.dirPath}/chunks`, sources), {
    kind: "chunksDir",
    sourceId: item.sourceId,
  });
  assert.deepEqual(parseVirtualPath(buildChunkFilePath(item, 2), sources), {
    kind: "chunkFile",
    sourceId: item.sourceId,
    chunkNo: 2,
  });
});

test("parseVirtualPath rejects unknown sources and malformed chunk files", () => {
  const item = source();

  assert.throws(() => parseVirtualPath("/kb/missing.md", [item]), /ENOENT/);
  assert.throws(() => parseVirtualPath(`${item.dirPath}/chunks/current.txt`, [item]), /ENOENT/);
});

test("findVirtualSource returns visible source or reports scoped miss", () => {
  const item = source();

  assert.equal(findVirtualSource([item], item.sourceId), item);
  assert.throws(() => findVirtualSource([item], "other-source"), /not visible in \/kb/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  isDropboxFileSupported,
  resolveDropboxFileHandling,
} from "../src/file-types";

test("downloads a PDF", () => {
  assert.deepEqual(resolveDropboxFileHandling("report.pdf", true), {
    kind: "download",
    mimeType: "application/pdf",
  });
});

test("downloads a Word document", () => {
  assert.deepEqual(resolveDropboxFileHandling("a.docx", true), {
    kind: "download",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
});

test("downloads a markdown file by either extension", () => {
  assert.deepEqual(resolveDropboxFileHandling("notes.md", true), {
    kind: "download",
    mimeType: "text/markdown",
  });
  assert.deepEqual(resolveDropboxFileHandling("notes.markdown", true), {
    kind: "download",
    mimeType: "text/markdown",
  });
});

test("downloads a CSV file", () => {
  assert.deepEqual(resolveDropboxFileHandling("data.csv", true), {
    kind: "download",
    mimeType: "text/csv",
  });
});

test("exports a non-downloadable Paper doc", () => {
  assert.deepEqual(resolveDropboxFileHandling("Plan.paper", false), {
    kind: "export_paper",
    mimeType: "text/markdown",
  });
});

test("treats an unmapped extension as unsupported", () => {
  assert.deepEqual(resolveDropboxFileHandling("photo.png", true), {
    kind: "unsupported",
  });
});

test("treats a non-downloadable supported extension as unsupported", () => {
  assert.deepEqual(resolveDropboxFileHandling("a.pdf", false), {
    kind: "unsupported",
  });
});

test("treats a name with no extension as unsupported", () => {
  assert.deepEqual(resolveDropboxFileHandling("README", true), {
    kind: "unsupported",
  });
});

test("extensions are case-insensitive", () => {
  assert.deepEqual(resolveDropboxFileHandling("REPORT.PDF", true), {
    kind: "download",
    mimeType: "application/pdf",
  });
  assert.deepEqual(resolveDropboxFileHandling("Notes.PAPER", false), {
    kind: "export_paper",
    mimeType: "text/markdown",
  });
});

test("isDropboxFileSupported mirrors resolveDropboxFileHandling", () => {
  assert.equal(isDropboxFileSupported("report.pdf", true), true);
  assert.equal(isDropboxFileSupported("Plan.paper", false), true);
  assert.equal(isDropboxFileSupported("photo.png", true), false);
  assert.equal(isDropboxFileSupported("a.pdf", false), false);
  assert.equal(isDropboxFileSupported("README", true), false);
});

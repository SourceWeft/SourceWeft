import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_DRIVE_PICKER_MIME_TYPES,
  exportedFileName,
  resolveDriveFileHandling,
} from "../src/file-types";

test("maps a Google Doc to a markdown export", () => {
  assert.deepEqual(
    resolveDriveFileHandling("application/vnd.google-apps.document"),
    {
      kind: "export_text",
      exportMimeType: "text/markdown",
      itemMimeType: "text/markdown",
      asMarkdown: true,
    },
  );
});

test("maps a Google Slides presentation to a plain-text export", () => {
  assert.deepEqual(
    resolveDriveFileHandling("application/vnd.google-apps.presentation"),
    {
      kind: "export_text",
      exportMimeType: "text/plain",
      itemMimeType: "text/plain",
      asMarkdown: false,
    },
  );
});

test("maps a Google Sheet to an xlsx file export", () => {
  assert.deepEqual(
    resolveDriveFileHandling("application/vnd.google-apps.spreadsheet"),
    {
      kind: "export_file",
      exportMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      itemMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    },
  );
});

const DOWNLOAD_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/markdown",
  "text/csv",
];

for (const mimeType of DOWNLOAD_MIME_TYPES) {
  test(`downloads "${mimeType}" as-is`, () => {
    assert.deepEqual(resolveDriveFileHandling(mimeType), {
      kind: "download",
      itemMimeType: mimeType,
    });
  });
}

test("treats an unmapped MIME type as unsupported", () => {
  assert.equal(resolveDriveFileHandling("image/png").kind, "unsupported");
});

test("the picker MIME allowlist is the union of every handled type", () => {
  const expected = new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.spreadsheet",
    ...DOWNLOAD_MIME_TYPES,
  ]);
  assert.deepEqual(new Set(GOOGLE_DRIVE_PICKER_MIME_TYPES), expected);
});

test("appends the extension when the name lacks it", () => {
  assert.equal(exportedFileName("Budget", "xlsx"), "Budget.xlsx");
});

test("does not duplicate an already-present extension", () => {
  assert.equal(exportedFileName("Budget.xlsx", "xlsx"), "Budget.xlsx");
});

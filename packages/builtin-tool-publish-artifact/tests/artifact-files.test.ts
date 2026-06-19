import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ARTIFACT_MIME_TYPES,
  isInlinePreviewableMimeType,
  mimeTypeForPath,
} from "../src";

test("mimeTypeForPath infers common artifact file types", () => {
  const cases = [
    ["/workspace/deck.pptx", ARTIFACT_MIME_TYPES.pptx],
    ["/workspace/report.pdf", ARTIFACT_MIME_TYPES.pdf],
    ["/workspace/report.xlsx", ARTIFACT_MIME_TYPES.xlsx],
    ["/workspace/table.csv", ARTIFACT_MIME_TYPES.csv],
    ["/workspace/archive.zip", ARTIFACT_MIME_TYPES.zip],
    ["/workspace/image.png", ARTIFACT_MIME_TYPES.png],
    ["/workspace/image.jpg", ARTIFACT_MIME_TYPES.jpeg],
    ["/workspace/image.webp", ARTIFACT_MIME_TYPES.webp],
    ["/workspace/page.html", ARTIFACT_MIME_TYPES.html],
    ["/workspace/unknown.bin", ARTIFACT_MIME_TYPES.binary],
  ] as const;

  for (const [path, expectedMimeType] of cases) {
    assert.equal(mimeTypeForPath(path), expectedMimeType);
  }
});

test("isInlinePreviewableMimeType keeps inline preview policy centralized", () => {
  assert.equal(isInlinePreviewableMimeType("image/png"), true);
  assert.equal(isInlinePreviewableMimeType("text/html; charset=utf-8"), true);
  assert.equal(isInlinePreviewableMimeType("application/pdf"), true);
  assert.equal(isInlinePreviewableMimeType("application/json"), true);
  assert.equal(isInlinePreviewableMimeType("application/zip"), false);
  assert.equal(
    isInlinePreviewableMimeType(ARTIFACT_MIME_TYPES.xlsx),
    false,
  );
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isSmallDocumentStats,
  trimContextWindowToChars,
} from "./assemble-context";

test("trimContextWindowToChars keeps the primary chunk and nearest context first", () => {
  const chunks = [
    { chunkNo: 0, content: "a".repeat(20) },
    { chunkNo: 1, content: "b".repeat(20) },
    { chunkNo: 2, content: "c".repeat(20) },
    { chunkNo: 3, content: "d".repeat(20) },
    { chunkNo: 4, content: "e".repeat(20) },
  ];

  const selected = trimContextWindowToChars(chunks, 2, 60);

  assert.deepEqual(
    selected.map((chunk) => chunk.chunkNo),
    [1, 2, 3],
  );
});

test("trimContextWindowToChars always keeps an oversized primary chunk", () => {
  const chunks = [
    { chunkNo: 1, content: "short" },
    { chunkNo: 2, content: "primary".repeat(100) },
    { chunkNo: 3, content: "short" },
  ];

  const selected = trimContextWindowToChars(chunks, 2, 60);

  assert.deepEqual(
    selected.map((chunk) => chunk.chunkNo),
    [2],
  );
});

test("isSmallDocumentStats uses structural chunk and character limits", () => {
  assert.equal(
    isSmallDocumentStats({
      documentId: "doc-1",
      sourceId: "source-1",
      chunkCount: 8,
      totalChars: 20000,
    }),
    true,
  );
  assert.equal(
    isSmallDocumentStats({
      documentId: "doc-2",
      sourceId: "source-1",
      chunkCount: 30,
      totalChars: 10000,
    }),
    true,
  );
  assert.equal(
    isSmallDocumentStats({
      documentId: "doc-3",
      sourceId: "source-1",
      chunkCount: 30,
      totalChars: 10001,
    }),
    false,
  );
});

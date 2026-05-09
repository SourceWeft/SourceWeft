import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePerTermGrepTopK,
  mergeVirtualFsGrepCandidates,
} from "./store";
import type { VirtualFsGrepCandidate } from "./types";

function candidate(input: {
  chunkId: string;
  chunkNo: number;
  score: number;
  content?: string;
}): VirtualFsGrepCandidate {
  return {
    sourceId: "source-1",
    sourceTitle: "Source 1",
    sourceFileName: "source.md",
    documentId: "document-1",
    chunkId: input.chunkId,
    chunkNo: input.chunkNo,
    content: input.content ?? `chunk ${input.chunkNo}`,
    startOffset: null,
    endOffset: null,
    headingPath: null,
    language: "markdown",
    score: input.score,
  };
}

test("calculatePerTermGrepTopK gives each recall term a bounded BM25 budget", () => {
  assert.equal(calculatePerTermGrepTopK({ termCount: 0, totalTopK: 300 }), 0);
  assert.equal(calculatePerTermGrepTopK({ termCount: 1, totalTopK: 300 }), 120);
  assert.equal(calculatePerTermGrepTopK({ termCount: 3, totalTopK: 300 }), 100);
  assert.equal(calculatePerTermGrepTopK({ termCount: 8, totalTopK: 300 }), 50);
});

test("mergeVirtualFsGrepCandidates deduplicates chunks and keeps the best score", () => {
  const merged = mergeVirtualFsGrepCandidates(
    [
      candidate({ chunkId: "chunk-1", chunkNo: 1, score: 0.2 }),
      candidate({ chunkId: "chunk-2", chunkNo: 2, score: 0.8 }),
      candidate({ chunkId: "chunk-1", chunkNo: 1, score: 0.9, content: "best" }),
    ],
    10,
  );

  assert.deepEqual(
    merged.map((item) => [item.chunkId, item.score, item.content]),
    [
      ["chunk-1", 0.9, "best"],
      ["chunk-2", 0.8, "chunk 2"],
    ],
  );
});

test("mergeVirtualFsGrepCandidates caps candidates after score ordering", () => {
  const merged = mergeVirtualFsGrepCandidates(
    [
      candidate({ chunkId: "chunk-1", chunkNo: 1, score: 0.1 }),
      candidate({ chunkId: "chunk-2", chunkNo: 2, score: 0.9 }),
      candidate({ chunkId: "chunk-3", chunkNo: 3, score: 0.5 }),
    ],
    2,
  );

  assert.deepEqual(
    merged.map((item) => item.chunkId),
    ["chunk-2", "chunk-3"],
  );
});

test("mergeVirtualFsGrepCandidates handles regex fallback candidates with neutral scores", () => {
  const merged = mergeVirtualFsGrepCandidates(
    [
      candidate({ chunkId: "chunk-1", chunkNo: 1, score: 0 }),
      candidate({ chunkId: "chunk-2", chunkNo: 2, score: 0 }),
    ],
    10,
  );

  assert.deepEqual(
    merged.map((item) => item.chunkId),
    ["chunk-1", "chunk-2"],
  );
});

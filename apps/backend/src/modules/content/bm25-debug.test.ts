import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  buildBm25ResultSummaries,
  buildContentPreview,
  logBm25Completed,
  logBm25RecallTerms,
  logBm25Skipped,
  normalizeBm25Score,
} from "./bm25-debug";

const originalConsoleLog = console.log;

afterEach(() => {
  console.log = originalConsoleLog;
});

test("buildContentPreview normalizes whitespace and truncates long chunks", () => {
  const preview = buildContentPreview(` first\n\n${"a".repeat(220)}   last `);

  assert.equal(preview.length, 180);
  assert.match(preview, /^first a+/u);
  assert.doesNotMatch(preview, /last/u);
});

test("buildBm25ResultSummaries keeps stable top result payload", () => {
  const summaries = buildBm25ResultSummaries([
    {
      chunkId: "chunk-1",
      sourceId: "source-1",
      chunkNo: 2,
      score: "0.42",
      content: "machine learning search",
    },
  ]);

  assert.deepEqual(summaries, [
    {
      chunkId: "chunk-1",
      sourceId: "source-1",
      chunkNo: 2,
      score: 0.42,
      contentPreview: "machine learning search",
    },
  ]);
});

test("normalizeBm25Score preserves the positive application score convention", () => {
  assert.equal(normalizeBm25Score("0.75"), 0.75);
  assert.equal(normalizeBm25Score(1.25), 1.25);
});

test("logBm25Skipped writes diagnostics by default", () => {
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  logBm25Skipped({
    operation: "retrieval",
    reason: "empty_search_query",
    queryText: "   ",
    topK: 12,
    sourceCount: 1,
  });

  assert.equal(logs.length, 1);
  assert.match(String(logs[0]?.[0]), /\[DEBUG\] bm25\.search/u);
  assert.deepEqual(logs[0]?.[1], {
    event: "skipped",
    operation: "retrieval",
    reason: "empty_search_query",
    query: {
      text: "   ",
      normalized: "",
    },
    request: {
      topK: 12,
      sourceCount: 1,
    },
  });
});

test("logBm25Completed writes a compact diagnostic payload by default", () => {
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  logBm25Completed({
    operation: "virtual_fs_grep",
    queryText: "机器学习 search",
    searchQuery: "机器 学习 search",
    topK: 20,
    sourceCount: 3,
    durationMs: 8,
    results: [
      {
        chunkId: "chunk-1",
        sourceId: "source-1",
        chunkNo: 1,
        score: 0.9,
        content: `${"visible ".repeat(40)}tail`,
      },
    ],
  });

  assert.equal(logs.length, 1);
  assert.match(String(logs[0]?.[0]), /\[DEBUG\] bm25\.search/u);
  assert.deepEqual(logs[0]?.[1], {
    event: "completed",
    operation: "virtual_fs_grep",
    query: {
      text: "机器学习 search",
      normalized: "机器 学习 search",
    },
    request: {
      topK: 20,
      sourceCount: 3,
    },
    timing: {
      durationMs: 8,
    },
    results: {
      count: 1,
      top: [
        {
          chunkId: "chunk-1",
          sourceId: "source-1",
          chunkNo: 1,
          score: 0.9,
          contentPreview: buildContentPreview(`${"visible ".repeat(40)}tail`),
        },
      ],
    },
  });
});

test("logBm25RecallTerms writes normalized recall diagnostics", () => {
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  logBm25RecallTerms({
    operation: "virtual_fs_recall_terms",
    termCount: 3,
    perTermTopK: 50,
    totalTopK: 120,
    sourceCount: 2,
    resultCount: 7,
  });

  assert.equal(logs.length, 1);
  assert.match(String(logs[0]?.[0]), /\[DEBUG\] bm25\.search/u);
  assert.deepEqual(logs[0]?.[1], {
    event: "recall_terms",
    operation: "virtual_fs_recall_terms",
    request: {
      termCount: 3,
      perTermTopK: 50,
      totalTopK: 120,
      sourceCount: 2,
    },
    results: {
      count: 7,
    },
  });
});

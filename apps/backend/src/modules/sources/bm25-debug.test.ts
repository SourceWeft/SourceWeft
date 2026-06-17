import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "vitest";
import pino from "pino";
import {
  buildBm25ResultSummaries,
  buildContentPreview,
  logBm25Completed,
  logBm25RecallTerms,
  logBm25Skipped,
  normalizeBm25Score,
} from "./bm25-debug";

/** Create a logger matching the adapter signature: debug(message, meta?) */
function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const base = pino({ level: "debug" }, stream);
  const log = {
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (meta) {
        base.debug(meta, message);
      } else {
        base.debug(message);
      }
    },
  };
  return { log, lines: () => chunks.filter(Boolean).map((s) => s.trim()).join("").split("\n") };
}

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
  const { log, lines } = captureLogger();

  logBm25Skipped(
    {
      operation: "retrieval",
      reason: "empty_search_query",
      queryText: "   ",
      topK: 12,
      sourceCount: 1,
    },
    log,
  );

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].msg, "bm25.search");
  assert.equal(parsed[0].level, 20);
  assert.equal(parsed[0].event, "skipped");
  assert.equal(parsed[0].operation, "retrieval");
  assert.equal(parsed[0].reason, "empty_search_query");
  assert.deepEqual(parsed[0].query, { text: "   ", normalized: "" });
  assert.deepEqual(parsed[0].request, { topK: 12, sourceCount: 1 });
});

test("logBm25Completed writes a compact diagnostic payload by default", () => {
  const { log, lines } = captureLogger();

  logBm25Completed(
    {
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
    },
    log,
  );

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].msg, "bm25.search");
  assert.equal(parsed[0].event, "completed");
  assert.equal(parsed[0].operation, "virtual_fs_grep");
  assert.deepEqual(parsed[0].query, {
    text: "机器学习 search",
    normalized: "机器 学习 search",
  });
  assert.deepEqual(parsed[0].request, { topK: 20, sourceCount: 3 });
  assert.deepEqual(parsed[0].timing, { durationMs: 8 });
  assert.equal(parsed[0].results.count, 1);
  assert.equal(parsed[0].results.top.length, 1);
  assert.equal(parsed[0].results.top[0].chunkId, "chunk-1");
  assert.equal(parsed[0].results.top[0].score, 0.9);
});

test("logBm25RecallTerms writes normalized recall diagnostics", () => {
  const { log, lines } = captureLogger();

  logBm25RecallTerms(
    {
      operation: "virtual_fs_recall_terms",
      termCount: 3,
      perTermTopK: 50,
      totalTopK: 120,
      sourceCount: 2,
      resultCount: 7,
    },
    log,
  );

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].msg, "bm25.search");
  assert.equal(parsed[0].event, "recall_terms");
  assert.equal(parsed[0].operation, "virtual_fs_recall_terms");
  assert.deepEqual(parsed[0].request, {
    termCount: 3,
    perTermTopK: 50,
    totalTopK: 120,
    sourceCount: 2,
  });
  assert.deepEqual(parsed[0].results, { count: 7 });
});

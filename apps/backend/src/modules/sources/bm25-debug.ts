import { logger as defaultLogger } from "../../shared/logger";

type LogFn = (message: string, meta?: Record<string, unknown>) => void;
/** `warn` is optional so callers can pass a debug-only logger. */
type DebugLogger = { debug: LogFn; warn?: LogFn };

const CONTENT_PREVIEW_CHARS = 180;
const MAX_RESULT_SUMMARIES = 5;
const BM25_LOG_EVENT = "bm25.search";

export type Bm25DebugResult = {
  chunkId: string;
  sourceId: string;
  chunkNo: number;
  score: number | string;
  content: string;
};

export type Bm25DebugSkippedInput = {
  operation: "retrieval" | "virtual_fs_grep";
  reason: "empty_source_ids" | "empty_search_query";
  queryText: string;
  searchQuery?: string;
  topK: number;
  sourceCount: number;
};

export type Bm25DebugCompletedInput = {
  operation: "retrieval" | "virtual_fs_grep";
  queryText: string;
  searchQuery: string;
  topK: number;
  sourceCount: number;
  durationMs: number;
  results: Bm25DebugResult[];
};

export type Bm25FailedInput = {
  operation: "retrieval" | "virtual_fs_grep";
  queryText: string;
  searchQuery?: string;
  error: string;
};

export type Bm25RecallTermsDebugInput = {
  operation: "virtual_fs_recall_terms";
  termCount: number;
  perTermTopK: number;
  totalTopK: number;
  sourceCount: number;
  resultCount?: number;
};

export function normalizeBm25Score(score: number | string) {
  return Number(score);
}

export function buildBm25ResultSummaries(results: Bm25DebugResult[]) {
  return results.slice(0, MAX_RESULT_SUMMARIES).map((result) => ({
    chunkId: result.chunkId,
    sourceId: result.sourceId,
    chunkNo: Number(result.chunkNo),
    score: normalizeBm25Score(result.score),
    contentPreview: buildContentPreview(result.content),
  }));
}

export function buildContentPreview(content: string) {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= CONTENT_PREVIEW_CHARS) {
    return normalized;
  }
  return normalized.slice(0, CONTENT_PREVIEW_CHARS);
}

export function logBm25Skipped(input: Bm25DebugSkippedInput, log?: DebugLogger) {
  const l = log ?? defaultLogger;
  l.debug(BM25_LOG_EVENT, {
    event: "skipped",
    operation: input.operation,
    reason: input.reason,
    query: {
      text: input.queryText,
      normalized: input.searchQuery ?? "",
    },
    request: {
      topK: input.topK,
      sourceCount: input.sourceCount,
    },
  });
}

export function logBm25Completed(input: Bm25DebugCompletedInput, log?: DebugLogger) {
  const l = log ?? defaultLogger;
  l.debug(BM25_LOG_EVENT, {
    event: "completed",
    operation: input.operation,
    query: {
      text: input.queryText,
      normalized: input.searchQuery,
    },
    request: {
      topK: input.topK,
      sourceCount: input.sourceCount,
    },
    timing: {
      durationMs: input.durationMs,
    },
    results: {
      count: input.results.length,
      top: buildBm25ResultSummaries(input.results),
    },
  });
}

export function logBm25RecallTerms(input: Bm25RecallTermsDebugInput, log?: DebugLogger) {
  const l = log ?? defaultLogger;
  l.debug(BM25_LOG_EVENT, {
    event: "recall_terms",
    operation: input.operation,
    request: {
      termCount: input.termCount,
      perTermTopK: input.perTermTopK,
      totalTopK: input.totalTopK,
      sourceCount: input.sourceCount,
    },
    results: {
      count: input.resultCount ?? 0,
    },
  });
}

export function logBm25Failed(input: Bm25FailedInput, log?: DebugLogger) {
  const l = log ?? defaultLogger;
  (l.warn ?? l.debug)(BM25_LOG_EVENT, {
    event: "failed",
    operation: input.operation,
    error: input.error,
    query: {
      text: input.queryText?.slice(0, 240),
      normalized: input.searchQuery?.slice(0, 240) ?? "",
    },
  });
}

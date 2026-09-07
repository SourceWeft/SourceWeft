import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_FUSION_LIMIT,
  DEFAULT_RERANK_TOP_N,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_TOP_K,
} from "../src/constants";
import {
  createInitialRetrievalState,
  resolveRetrievalTuning,
} from "../src/pipeline/state";
import type { RetrievalInput } from "../src/pipeline/types";

function inputFixture(overrides?: Partial<RetrievalInput>): RetrievalInput {
  return {
    workspaceId: "ws-1",
    teamId: "team-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "msg-1",
    queryText: "query",
    sourceIds: [],
    ...overrides,
  };
}

test("tuning falls back to the package defaults when unset", () => {
  assert.deepEqual(resolveRetrievalTuning(undefined), {
    vectorTopK: DEFAULT_VECTOR_TOP_K,
    bm25TopK: DEFAULT_BM25_TOP_K,
    rrfK: DEFAULT_RRF_K,
    fusionLimit: DEFAULT_FUSION_LIMIT,
    rerankTopN: DEFAULT_RERANK_TOP_N,
    bm25FailurePolicy: "fail",
  });
});

test("caller overrides win, unspecified fields still default", () => {
  const resolved = resolveRetrievalTuning({ vectorTopK: 32, rrfK: 10 });

  assert.equal(resolved.vectorTopK, 32);
  assert.equal(resolved.rrfK, 10);
  assert.equal(resolved.bm25TopK, DEFAULT_BM25_TOP_K);
  assert.equal(resolved.rerankTopN, DEFAULT_RERANK_TOP_N);
});

test("initial state resolves tuning once from the input", () => {
  // Search, ranking, and the audit record all read state.tuning, so resolving
  // it here is what keeps them from disagreeing.
  const state = createInitialRetrievalState(
    inputFixture({ tuning: { bm25TopK: 25 } }),
  );

  assert.equal(state.tuning.bm25TopK, 25);
  assert.equal(state.tuning.vectorTopK, DEFAULT_VECTOR_TOP_K);
});

test("initial state starts with no recorded degradations", () => {
  assert.deepEqual(
    createInitialRetrievalState(inputFixture()).degradations,
    [],
  );
});

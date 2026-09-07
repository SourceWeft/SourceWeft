import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_FUSION_LIMIT,
  DEFAULT_RERANK_TOP_N,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_TOP_K,
} from "../constants";
import type {
  PreparedRetrievalPipelineState,
  ResolvedRetrievalTuning,
  RetrievalInput,
  RetrievalPipelineState,
  RetrievalTuning,
} from "./types";

export function resolveRetrievalTuning(
  tuning?: RetrievalTuning,
): ResolvedRetrievalTuning {
  return {
    vectorTopK: tuning?.vectorTopK ?? DEFAULT_VECTOR_TOP_K,
    bm25TopK: tuning?.bm25TopK ?? DEFAULT_BM25_TOP_K,
    rrfK: tuning?.rrfK ?? DEFAULT_RRF_K,
    fusionLimit: tuning?.fusionLimit ?? DEFAULT_FUSION_LIMIT,
    rerankTopN: tuning?.rerankTopN ?? DEFAULT_RERANK_TOP_N,
    bm25FailurePolicy: tuning?.bm25FailurePolicy ?? "fail",
  };
}

export function createInitialRetrievalState(
  input: RetrievalInput,
): RetrievalPipelineState {
  return {
    input,
    tuning: resolveRetrievalTuning(input.tuning),
    degradations: [],
    anchorSourceIds: [],
    retrievalSourceIds: [],
    sourceIds: [],
    profile: null,
    planner: null,
    queryEmbedding: [],
    candidates: {
      bm25: [],
      vector: [],
      fused: [],
      final: [],
    },
    timings: {
      embeddingLatencyMs: 0,
      bm25LatencyMs: 0,
      vectorLatencyMs: 0,
      rerankLatencyMs: 0,
    },
    gateway: {
      embedding: null,
      rerank: null,
    },
    contextAssembly: null,
    retrievalRunId: null,
  };
}

export function requirePreparedRetrievalState(
  state: RetrievalPipelineState,
): PreparedRetrievalPipelineState {
  if (!state.profile || !state.planner) {
    throw new Error(
      "Retrieval pipeline was not prepared: missing profile or planner",
    );
  }

  return state as PreparedRetrievalPipelineState;
}

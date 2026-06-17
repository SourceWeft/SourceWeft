import type {
  PreparedRetrievalPipelineState,
  RetrievalInput,
  RetrievalPipelineState,
} from "./types";

export function createInitialRetrievalState(
  input: RetrievalInput,
): RetrievalPipelineState {
  return {
    input,
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

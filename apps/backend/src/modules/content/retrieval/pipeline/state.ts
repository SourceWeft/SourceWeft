import { ContentError } from "../../errors";
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
    modelAliases: {
      embed: null,
      rerank: null,
    },
    timings: {
      embeddingLatencyMs: 0,
      bm25LatencyMs: 0,
      vectorLatencyMs: 0,
      rerankLatencyMs: 0,
      retrievalLatencyMs: 0,
    },
    gateway: {
      embedding: null,
      rerank: null,
    },
    retrievalRunId: null,
  };
}

export function requirePreparedRetrievalState(
  state: RetrievalPipelineState,
): PreparedRetrievalPipelineState {
  if (!state.profile || !state.planner) {
    throw new ContentError(
      500,
      "RETRIEVAL_PIPELINE_NOT_PREPARED",
      "Retrieval pipeline was not prepared",
    );
  }

  return state as PreparedRetrievalPipelineState;
}

import { buildGatewayAuditMetadata } from "../../../model-gateway-audit";
import { createRetrievalHits, createRetrievalRun } from "../../repository";
import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_TOP_K,
} from "../constants";
import { requirePreparedRetrievalState } from "../state";
import type { RetrievalPipelineStage } from "../types";

export const persistRetrievalAuditStage: RetrievalPipelineStage = {
  name: "persist-audit",
  async run(state) {
    const prepared = requirePreparedRetrievalState(state);
    const { input, planner, profile, sourceIds } = prepared;

    const isEmptySourceRun = sourceIds.length === 0;
    const retrievalRunId = await createRetrievalRun({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.userMessageId,
      embeddingProfileId: profile.id,
      queryText: input.queryText,
      embedModelAlias: profile.modelAlias,
      rerankModelAlias: state.modelAliases.rerank,
      vectorStrategyUsed: planner.strategy,
      annIndexUsed: planner.annIndexUsed,
      bm25TopK: DEFAULT_BM25_TOP_K,
      vectorTopK: DEFAULT_VECTOR_TOP_K,
      rrfK: DEFAULT_RRF_K,
      prefilterCount: isEmptySourceRun ? 0 : null,
      candidateCount: isEmptySourceRun
        ? 0
        : Math.max(state.candidates.bm25.length, state.candidates.vector.length),
      finalResultCount: state.candidates.final.length,
      latencyMs: isEmptySourceRun ? 0 : state.timings.retrievalLatencyMs,
      metadataJson: isEmptySourceRun
        ? {
            requestedSourceIds: sourceIds,
            gateway: {
              embedding: null,
              rerank: buildGatewayAuditMetadata({ llm: input.llm }),
            },
          }
        : {
            requestedSourceIds: sourceIds,
            timings: state.timings,
            gateway: state.gateway,
          },
    });

    await createRetrievalHits({
      runId: retrievalRunId,
      hits: [
        ...state.candidates.vector.map((candidate, index) => ({
          sourceStage: "vector" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        })),
        ...state.candidates.bm25.map((candidate, index) => ({
          sourceStage: "bm25" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        })),
        ...state.candidates.fused.map((candidate, index) => ({
          sourceStage: "rrf" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        })),
        ...state.candidates.final.map((candidate, index) => ({
          sourceStage: "rerank" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        })),
      ],
    });

    return {
      ...state,
      retrievalRunId,
    };
  },
};

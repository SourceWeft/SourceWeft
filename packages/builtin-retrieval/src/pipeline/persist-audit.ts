import {
} from "../index";
import type { RetrievalDataAccess } from "../data-access";
import { requirePreparedRetrievalState } from "./state";
import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

export function createPersistRetrievalAuditStage(deps: {
  dataAccess: RetrievalDataAccess;
}): RetrievalPipelineStage {
  return {
    name: "persist-audit",
    async run(state: RetrievalPipelineState): Promise<RetrievalPipelineState> {
      const prepared = requirePreparedRetrievalState(state);
      const { anchorSourceIds, input, planner, profile, sourceIds } = prepared;

      const isNoSourceRun = prepared.retrievalSourceIds.length === 0;
      const candidateCount = Math.max(
        state.candidates.bm25.length,
        state.candidates.vector.length,
      );
      const retrievalRunId = await deps.dataAccess.createRetrievalRun({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.userMessageId,
        embeddingProfileId: profile.id,
        queryText: input.queryText,
        embedModelAlias: profile.modelAlias,
        rerankModelAlias: null,
        vectorStrategyUsed: planner.strategy,
        annIndexUsed: planner.annIndexUsed,
        bm25TopK: state.tuning.bm25TopK,
        vectorTopK: state.tuning.vectorTopK,
        rrfK: state.tuning.rrfK,
        prefilterCount: isNoSourceRun ? 0 : prepared.retrievalSourceIds.length,
        candidateCount: isNoSourceRun ? 0 : candidateCount,
        finalResultCount: state.candidates.final.length,
        latencyMs: isNoSourceRun ? 0 : state.timings.rerankLatencyMs,
        metadataJson: {
          requestedSourceIds: sourceIds,
          anchorSourceIds,
          anchorOnly: sourceIds.length === 0 && anchorSourceIds.length > 0,
          noSourceRun: isNoSourceRun,
          timings: state.timings,
          gateway: state.gateway,
          contextAssembly: state.contextAssembly,
          tuning: state.tuning,
          ...(state.degradations.length > 0
            ? { degradations: state.degradations }
            : {}),
        },
      });

      await deps.dataAccess.createRetrievalHits({
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
}

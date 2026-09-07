import { type RetrievalCandidate } from "../index";
import type {
  RetrievalDataAccess,
  RetrievalEmbeddingGateway,
} from "../data-access";
import { requirePreparedRetrievalState } from "./state";
import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

function mergeCandidates(
  generalCandidates: readonly RetrievalCandidate[],
  anchorCandidates: readonly RetrievalCandidate[],
) {
  const merged = new Map<string, RetrievalCandidate>();
  for (const candidate of generalCandidates) {
    merged.set(candidate.chunkId, candidate);
  }
  for (const candidate of anchorCandidates) {
    const existing = merged.get(candidate.chunkId);
    if (!existing) {
      merged.set(candidate.chunkId, candidate);
      continue;
    }
    merged.set(candidate.chunkId, {
      ...existing,
      score: Math.max(existing.score, candidate.score),
    });
  }
  return Array.from(merged.values());
}

export function createSearchCandidatesStage(deps: {
  dataAccess: RetrievalDataAccess;
  embeddingGateway: RetrievalEmbeddingGateway;
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}): RetrievalPipelineStage {
  return {
    name: "search-candidates",
    async run(state: RetrievalPipelineState): Promise<RetrievalPipelineState> {
      const prepared = requirePreparedRetrievalState(state);
      const {
        anchorSourceIds,
        input,
        planner,
        profile,
        retrievalSourceIds,
        sourceIds,
      } = prepared;

      if (retrievalSourceIds.length === 0) {
        return state;
      }

      let queryEmbedding = state.queryEmbedding;
      let embeddingLatencyMs = state.timings.embeddingLatencyMs;

      if (planner.strategy !== "bm25_only") {
        const embedStartedAt = Date.now();
        queryEmbedding = await deps.embeddingGateway.embed({
          queryText: input.queryText,
          dimensions: planner.requestedDimensions ?? 0,
          modelAlias: profile.modelAlias,
          gatewayConfigId: profile.gatewayConfigId,
        });
        embeddingLatencyMs = Date.now() - embedStartedAt;
      }

      const degradations = [...state.degradations];
      async function searchBm25(branchSourceIds: string[], stage: string) {
        try {
          return await deps.dataAccess.searchChunksByBm25({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            queryText: input.queryText,
            topK: state.tuning.bm25TopK,
            sourceIds: branchSourceIds,
          });
        } catch (error) {
          // A BM25-only run has no surviving channel, even when hybrid
          // degradation was explicitly allowed by its caller.
          if (
            planner.strategy === "bm25_only" ||
            state.tuning.bm25FailurePolicy !== "allow_vector"
          ) {
            throw error;
          }
          const reason = error instanceof Error ? error.message : String(error);
          degradations.push({ stage, reason });
          deps.logger?.warn?.("retrieval.bm25.failed", {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            stage,
            reason,
          });
          return [];
        }
      }
      const bm25StartedAt = Date.now();
      const bm25Candidates = await searchBm25(
        retrievalSourceIds,
        "bm25-search",
      );
      const bm25LatencyMs = Date.now() - bm25StartedAt;

      const vectorStartedAt = Date.now();
      const vectorCandidates =
        planner.strategy === "ann_hnsw" && planner.requestedDimensions
          ? await deps.dataAccess.searchChunksByVectorAnn({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              embeddingProfileId: profile.id,
              queryEmbedding,
              dim: planner.requestedDimensions,
              topK: state.tuning.vectorTopK,
              sourceIds: retrievalSourceIds,
            })
          : planner.strategy !== "bm25_only"
            ? await deps.dataAccess.searchChunksByVectorExact({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                embeddingProfileId: profile.id,
                queryEmbedding,
                topK: state.tuning.vectorTopK,
                sourceIds: retrievalSourceIds,
              })
            : [];
      const vectorLatencyMs = Date.now() - vectorStartedAt;

      const shouldRunAnchorBranch =
        sourceIds.length > 0 && anchorSourceIds.length > 0;
      const anchorBm25Candidates = shouldRunAnchorBranch
        ? await searchBm25(anchorSourceIds, "anchor-bm25-search")
        : [];
      const anchorVectorCandidates =
        shouldRunAnchorBranch && planner.strategy !== "bm25_only"
          ? planner.strategy === "ann_hnsw" && planner.requestedDimensions
            ? await deps.dataAccess.searchChunksByVectorAnn({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                embeddingProfileId: profile.id,
                queryEmbedding,
                dim: planner.requestedDimensions,
                topK: state.tuning.vectorTopK,
                sourceIds: anchorSourceIds,
              })
            : await deps.dataAccess.searchChunksByVectorExact({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                embeddingProfileId: profile.id,
                queryEmbedding,
                topK: state.tuning.vectorTopK,
                sourceIds: anchorSourceIds,
              })
          : [];

      return {
        ...state,
        degradations,
        queryEmbedding,
        candidates: {
          ...state.candidates,
          bm25: mergeCandidates(bm25Candidates, anchorBm25Candidates),
          vector: mergeCandidates(vectorCandidates, anchorVectorCandidates),
        },
        timings: {
          ...state.timings,
          embeddingLatencyMs,
          bm25LatencyMs,
          vectorLatencyMs,
        },
      };
    },
  };
}

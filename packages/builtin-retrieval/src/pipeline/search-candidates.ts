import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_VECTOR_TOP_K,
  type RetrievalCandidate,
} from "../index";
import type { RetrievalDataAccess, RetrievalEmbeddingGateway } from "../data-access";
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

      const bm25StartedAt = Date.now();
      let bm25Candidates: readonly RetrievalCandidate[] = [];
      try {
        bm25Candidates = await deps.dataAccess.searchChunksByBm25({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          queryText: input.queryText,
          topK: DEFAULT_BM25_TOP_K,
          sourceIds: retrievalSourceIds,
        });
      } catch {
        // BM25 search failed — vector search may still produce results
      }
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
              topK: DEFAULT_VECTOR_TOP_K,
              sourceIds: retrievalSourceIds,
            })
          : planner.strategy !== "bm25_only"
            ? await deps.dataAccess.searchChunksByVectorExact({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                embeddingProfileId: profile.id,
                queryEmbedding,
                topK: DEFAULT_VECTOR_TOP_K,
                sourceIds: retrievalSourceIds,
              })
            : [];
      const vectorLatencyMs = Date.now() - vectorStartedAt;

      const shouldRunAnchorBranch =
        sourceIds.length > 0 && anchorSourceIds.length > 0;
      const anchorBm25Candidates = shouldRunAnchorBranch
        ? await (async () => {
            try {
              return await deps.dataAccess.searchChunksByBm25({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                queryText: input.queryText,
                topK: DEFAULT_BM25_TOP_K,
                sourceIds: anchorSourceIds,
              });
            } catch {
              return [];
            }
          })()
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
                topK: DEFAULT_VECTOR_TOP_K,
                sourceIds: anchorSourceIds,
              })
            : await deps.dataAccess.searchChunksByVectorExact({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                embeddingProfileId: profile.id,
                queryEmbedding,
                topK: DEFAULT_VECTOR_TOP_K,
                sourceIds: anchorSourceIds,
              })
          : [];

      return {
        ...state,
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

import {
  reciprocalRankFusion,
  rerankCandidates,
  DEFAULT_FUSION_LIMIT,
  DEFAULT_RERANK_TOP_N,
  DEFAULT_RRF_K,
  type RerankGateway,
} from "../index";
import { requirePreparedRetrievalState } from "./state";
import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

export function createRankCandidatesStage(deps: {
  rerankGateway: RerankGateway;
}): RetrievalPipelineStage {
  return {
    name: "rank-candidates",
    async run(state: RetrievalPipelineState): Promise<RetrievalPipelineState> {
      const prepared = requirePreparedRetrievalState(state);
      const { input } = prepared;

      if (prepared.retrievalSourceIds.length === 0) {
        return state;
      }

      const fusedCandidates = reciprocalRankFusion({
        vectorCandidates: state.candidates.vector,
        bm25Candidates: state.candidates.bm25,
        limit: DEFAULT_FUSION_LIMIT,
        rrfK: DEFAULT_RRF_K,
      });

      const rerankStartedAt = Date.now();
      const rerankedCandidates = await rerankCandidates({
        queryText: input.queryText,
        candidates: fusedCandidates,
        topN: DEFAULT_RERANK_TOP_N,
        gateway: deps.rerankGateway,
      });
      const rerankLatencyMs = Date.now() - rerankStartedAt;
      const finalCandidates =
        rerankedCandidates.length > 0 ? rerankedCandidates : fusedCandidates;

      return {
        ...state,
        candidates: {
          ...state.candidates,
          fused: fusedCandidates,
          final: finalCandidates,
        },
        timings: {
          ...state.timings,
          rerankLatencyMs,
        },
      };
    },
  };
}

import { reciprocalRankFusion } from "../../planner";
import { rerankCandidates } from "../../rerank";
import { DEFAULT_FUSION_LIMIT, DEFAULT_RRF_K } from "../constants";
import { requirePreparedRetrievalState } from "../state";
import type { RetrievalPipelineStage } from "../types";

export const rankCandidatesStage: RetrievalPipelineStage = {
  name: "rank-candidates",
  async run(state) {
    const prepared = requirePreparedRetrievalState(state);
    const { input } = prepared;

    if (prepared.sourceIds.length === 0) {
      return state;
    }

    const fusedCandidates = reciprocalRankFusion({
      vectorCandidates: state.candidates.vector,
      bm25Candidates: state.candidates.bm25,
      limit: DEFAULT_FUSION_LIMIT,
      rrfK: DEFAULT_RRF_K,
    });

    const rerankStartedAt = Date.now();
    const rerank = await rerankCandidates({
      queryText: input.queryText,
      candidates: fusedCandidates,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      llm: input.llm,
    });
    const rerankLatencyMs = Date.now() - rerankStartedAt;
    const finalCandidates =
      rerank.candidates.length > 0 ? rerank.candidates : fusedCandidates;

    return {
      ...state,
      candidates: {
        ...state.candidates,
        fused: fusedCandidates,
        final: finalCandidates,
      },
      modelAliases: {
        ...state.modelAliases,
        rerank: rerank.modelAlias,
      },
      timings: {
        ...state.timings,
        rerankLatencyMs,
      },
      gateway: {
        ...state.gateway,
        rerank: rerank.gateway ?? null,
      },
    };
  },
};

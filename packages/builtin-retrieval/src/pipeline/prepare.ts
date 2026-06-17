import type { RetrievalPlannerResult } from "../index";
import type { EmbeddingProfile, RetrievalDataAccess } from "../data-access";
import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

export function createPrepareRetrievalStage(deps: {
  dataAccess: RetrievalDataAccess;
  planStrategy: (profile: EmbeddingProfile) => RetrievalPlannerResult;
}): RetrievalPipelineStage {
  return {
    name: "prepare",
    async run(state: RetrievalPipelineState): Promise<RetrievalPipelineState> {
      const profile = await deps.dataAccess.findDefaultEmbeddingProfile();
      if (!profile) {
        throw new Error(
          "Default embedding profile is not configured",
        );
      }

      const planner = deps.planStrategy(profile);
      const sourceIds = [...new Set(state.input.sourceIds)];
      const anchorSourceIds = [
        ...new Set(state.input.anchorSourceIds ?? []),
      ].filter(
        (sourceId) => sourceIds.length === 0 || sourceIds.includes(sourceId),
      );

      return {
        ...state,
        anchorSourceIds,
        retrievalSourceIds:
          sourceIds.length > 0
            ? sourceIds
            : anchorSourceIds.length > 0
              ? anchorSourceIds
              : [],
        sourceIds,
        profile,
        planner,
      };
    },
  };
}

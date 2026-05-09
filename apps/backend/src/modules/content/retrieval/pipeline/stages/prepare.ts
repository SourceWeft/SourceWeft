import {
  ensureModelConfigAvailable,
  requireDefaultModelGatewayProfile,
} from "../../../../../shared/model-gateway/index";
import { ContentError } from "../../../errors";
import { planRetrievalStrategy } from "../../planner";
import type { RetrievalPipelineStage } from "../types";

async function requireDefaultEmbeddingProfile() {
  try {
    const profile = await requireDefaultModelGatewayProfile("embedding");
    return {
      ...profile,
      kind: "embedding" as const,
    };
  } catch {
    throw new ContentError(
      500,
      "EMBEDDING_PROFILE_NOT_CONFIGURED",
      "Default embedding profile is not configured",
    );
  }
}

export const prepareRetrievalStage: RetrievalPipelineStage = {
  name: "prepare",
  async run(state) {
    await ensureModelConfigAvailable();
    const profile = await requireDefaultEmbeddingProfile();
    const planner = planRetrievalStrategy(profile);
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
      modelAliases: {
        ...state.modelAliases,
        embed: profile.modelAlias,
      },
    };
  },
};

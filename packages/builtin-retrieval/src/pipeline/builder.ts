import type { RetrievalDataAccess, RetrievalEmbeddingGateway } from "../data-access";
import type { RerankGateway } from "../rerank";
import type { RetrievalPlannerResult } from "../types";
import type { EmbeddingProfile } from "../data-access";
import { createAssembleContextStage } from "./assemble-context";
import { createPersistRetrievalAuditStage } from "./persist-audit";
import { createPrepareRetrievalStage } from "./prepare";
import { createRankCandidatesStage } from "./rank-candidates";
import { createSearchCandidatesStage } from "./search-candidates";
import type { RetrievalPipelineStage } from "./types";

export function createRetrievalPipeline(deps: {
  dataAccess: RetrievalDataAccess;
  embeddingGateway: RetrievalEmbeddingGateway;
  rerankGateway: RerankGateway;
  planStrategy: (profile: EmbeddingProfile) => RetrievalPlannerResult;
}): RetrievalPipelineStage[] {
  return [
    createPrepareRetrievalStage({
      dataAccess: deps.dataAccess,
      planStrategy: deps.planStrategy,
    }),
    createSearchCandidatesStage({
      dataAccess: deps.dataAccess,
      embeddingGateway: deps.embeddingGateway,
    }),
    createRankCandidatesStage({ rerankGateway: deps.rerankGateway }),
    createAssembleContextStage({ dataAccess: deps.dataAccess }),
    createPersistRetrievalAuditStage({ dataAccess: deps.dataAccess }),
  ];
}

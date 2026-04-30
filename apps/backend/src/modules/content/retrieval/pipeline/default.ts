import type { RetrievalPipelineStage } from "./types";
import { persistRetrievalAuditStage } from "./stages/persist-audit";
import { prepareRetrievalStage } from "./stages/prepare";
import { rankCandidatesStage } from "./stages/rank-candidates";
import { searchCandidatesStage } from "./stages/search-candidates";

export function createDefaultRetrievalPipeline(): RetrievalPipelineStage[] {
  return [
    prepareRetrievalStage,
    searchCandidatesStage,
    rankCandidatesStage,
    persistRetrievalAuditStage,
  ];
}

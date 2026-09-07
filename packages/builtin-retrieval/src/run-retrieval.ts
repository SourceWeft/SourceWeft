import { buildCitationMetadata } from "./ranking";
import { createRetrievalPipeline } from "./pipeline/builder";
import { runPipeline } from "./pipeline-runner";
import {
  createInitialRetrievalState,
  requirePreparedRetrievalState,
} from "./pipeline/state";
import type { RetrievalInput } from "./pipeline/types";
import type {
  RetrievalDataAccess,
  RetrievalEmbeddingGateway,
} from "./data-access";
import type { RerankGateway } from "./rerank";
import type { RetrievalPlannerResult } from "./types";
import type { EmbeddingProfile } from "./data-access";

export async function runRetrieval(
  input: RetrievalInput,
  deps: {
    dataAccess: RetrievalDataAccess;
    embeddingGateway: RetrievalEmbeddingGateway;
    rerankGateway: RerankGateway;
    planStrategy: (profile: EmbeddingProfile) => RetrievalPlannerResult;
  },
) {
  const stages = createRetrievalPipeline(deps);
  const state = await runPipeline(createInitialRetrievalState(input), stages);
  const prepared = requirePreparedRetrievalState(state);

  return {
    profile: prepared.profile,
    planner: prepared.planner,
    fusedCandidates: state.candidates.final,
    retrievalSummary: buildCitationMetadata(state.candidates.final),
    contextAssembly: state.contextAssembly,
    timings: state.timings,
    degradations: state.degradations,
  };
}

import { buildCitationMetadata } from "./planner";
import { createDefaultRetrievalPipeline } from "./pipeline/default";
import { runRetrievalPipeline } from "./pipeline/runner";
import {
  createInitialRetrievalState,
  requirePreparedRetrievalState,
} from "./pipeline/state";
import type { RetrievalInput } from "./pipeline/types";

class ContentRetrievalService {
  async runRetrieval(input: RetrievalInput) {
    const state = await runRetrievalPipeline({
      initialState: createInitialRetrievalState(input),
      stages: createDefaultRetrievalPipeline(),
    });
    const prepared = requirePreparedRetrievalState(state);

    return {
      profile: prepared.profile,
      planner: prepared.planner,
      fusedCandidates: state.candidates.final,
      retrievalSummary: buildCitationMetadata(state.candidates.final),
    };
  }
}

export const contentRetrievalService = new ContentRetrievalService();

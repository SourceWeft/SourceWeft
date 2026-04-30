import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

export async function runRetrievalPipeline(input: {
  initialState: RetrievalPipelineState;
  stages: RetrievalPipelineStage[];
}) {
  let state = input.initialState;
  const startedAt = Date.now();

  for (const stage of input.stages) {
    state = {
      ...state,
      timings: {
        ...state.timings,
        retrievalLatencyMs: Date.now() - startedAt,
      },
    };
    state = await stage.run(state);
  }

  return {
    ...state,
    timings: {
      ...state.timings,
      retrievalLatencyMs: Date.now() - startedAt,
    },
  };
}

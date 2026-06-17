import type { RetrievalPipelineStage } from "./pipeline-contracts";

export async function runPipeline<TState extends object>(
  initialState: TState,
  stages: readonly RetrievalPipelineStage<TState>[],
): Promise<TState> {
  let state = initialState;
  for (const stage of stages) {
    state = await stage.run(state);
  }
  return state;
}

import {
  createVideoPresentationTools,
  type VideoPresentationFactoryInput,
} from "./agent/factory";

/** Capability entrypoint: the root Agent owns planning; these are its typed tools. */
export function createCapabilityAgentTools(
  input: VideoPresentationFactoryInput,
) {
  return {
    promptProviders: [],
    tools: createVideoPresentationTools(input),
  };
}

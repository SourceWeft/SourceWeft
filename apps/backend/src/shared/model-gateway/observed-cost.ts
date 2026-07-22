import type { GenerationCostResolver } from "../../modules/llm-observability/sink";
import {
  computeProviderCost,
  createCachedProviderCostLookups,
} from "../../modules/content/provider-cost";
import type { ModelProfileKind } from "../../modules/content/types";

// Written as a total record rather than a Set so that adding a kind to
// ModelProfileKind fails to compile here instead of silently going uncosted.
const MODEL_PROFILE_KINDS: Record<ModelProfileKind, true> = {
  chat: true,
  image: true,
  vision: true,
  video: true,
  asr: true,
  tts: true,
  embedding: true,
  rerank: true,
};

function toModelProfileKind(value: string): ModelProfileKind | null {
  return Object.hasOwn(MODEL_PROFILE_KINDS, value)
    ? (value as ModelProfileKind)
    : null;
}

/**
 * Cost attribution for observability. This runs once per *generation* — which
 * includes embeddings on every retrieval — rather than once per billable call,
 * so it reads pricing through a TTL cache. A stale read here mis-states a
 * reporting figure; it can never change what a customer is charged, because
 * billing resolves cost separately through the uncached default lookups.
 */
const cachedLookups = createCachedProviderCostLookups();

export const resolveObservedGenerationCost: GenerationCostResolver = async (
  input,
) => {
  const modelKind = toModelProfileKind(input.modelKind);
  if (!modelKind) {
    return null;
  }

  const cost = await computeProviderCost({
    gatewayConfigId: input.gatewayConfigId,
    modelKind,
    profileAlias: input.profileAlias,
    usage: input.usage,
    llm: input.executionMode
      ? { executionMode: input.executionMode as "GLOBAL" | "BYOK" }
      : undefined,
    lookups: cachedLookups,
  });

  return {
    providerCostUsd: cost.providerCostUsd,
    costSource: cost.costSource,
  };
};

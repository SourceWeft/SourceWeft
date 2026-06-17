import { planRetrievalStrategy as planStrategy } from "@sourceweft/builtin-retrieval";
import type { RetrievalPlannerResult, EmbeddingProfile } from "@sourceweft/builtin-retrieval";
import { vectorSearchProvider } from "./vector";

const STATIC_ANN_INDEXES: Record<string, string> = {
  "global:embedding:bge-m3-1024:1024":
    "chunk_embeddings_global_embedding_bge_m3_1024_hnsw_idx",
};

function getStaticAnnIndex(profileId: string, dimensions: number | null) {
  if (dimensions === null) {
    return null;
  }
  return STATIC_ANN_INDEXES[`${profileId}:${dimensions}`] ?? null;
}

export function planRetrievalStrategy(
  profile: EmbeddingProfile,
): RetrievalPlannerResult {
  const dimensions = profile.requestedDimensions ?? null;

  return planStrategy({
    vectorStrategy: profile.vectorStrategy,
    dimensions,
    resolveAnnIndex: (dims) => getStaticAnnIndex(profile.id, dims),
    validateDimensions: (dims) => vectorSearchProvider.validateDimensions(dims),
    supportsAnn: (dims) => vectorSearchProvider.supportsAnn(dims),
  });
}

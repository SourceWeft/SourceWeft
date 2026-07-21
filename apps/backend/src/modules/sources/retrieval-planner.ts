import { planRetrievalStrategy as planStrategy } from "@sourceweft/builtin-retrieval";
import type { RetrievalPlannerResult, EmbeddingProfile } from "@sourceweft/builtin-retrieval";
import { supportsAnnSearch, validateEmbeddingDimensions } from "./vector";

/**
 * Fallback map for profiles that predate `annIndexName`. New embedding models
 * should set the index name on the profile instead of being added here — this
 * table only exists so existing profiles keep resolving their index.
 */
const STATIC_ANN_INDEXES: Record<string, string> = {
  "global:embedding:bge-m3-1024:1024":
    "chunk_embeddings_global_embedding_bge_m3_1024_hnsw_idx",
};

function resolveAnnIndexName(
  profile: EmbeddingProfile,
  dimensions: number | null,
) {
  if (dimensions === null) {
    return null;
  }
  return (
    profile.annIndexName ??
    STATIC_ANN_INDEXES[`${profile.id}:${dimensions}`] ??
    null
  );
}

export function planRetrievalStrategy(
  profile: EmbeddingProfile,
): RetrievalPlannerResult {
  const dimensions = profile.requestedDimensions ?? null;

  return planStrategy({
    vectorStrategy: profile.vectorStrategy,
    dimensions,
    resolveAnnIndex: (dims) => resolveAnnIndexName(profile, dims),
    validateDimensions: validateEmbeddingDimensions,
    supportsAnn: supportsAnnSearch,
  });
}

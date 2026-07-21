import { config } from "../../shared/config";
import { ContentError } from "../content/errors";

/**
 * Ceiling for a pgvector embedding column/index. Enforced here rather than at
 * the query, so an over-wide profile is refused while planning instead of
 * failing mid-search.
 */
const MAX_VECTOR_DIMENSIONS = config.vectorSearch.maxDimensions;

export function validateEmbeddingDimensions(dimensions: number | null) {
  if (dimensions === null) {
    return;
  }

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new ContentError(
      400,
      "EMBEDDING_DIMENSION_INVALID",
      "Embedding dimensions must be a positive integer",
    );
  }

  if (dimensions > MAX_VECTOR_DIMENSIONS) {
    throw new ContentError(
      400,
      "EMBEDDING_DIMENSION_EXCEEDED",
      `Embedding dimensions ${dimensions} exceed ${MAX_VECTOR_DIMENSIONS} for pgvector`,
    );
  }
}

/** pgvector always has ANN available; the only question is whether it fits. */
export function supportsAnnSearch(
  dimensions: number | null,
): dimensions is number {
  return dimensions !== null && dimensions <= MAX_VECTOR_DIMENSIONS;
}

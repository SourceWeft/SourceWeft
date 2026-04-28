import { ContentError } from "../errors";
import {
  searchChunksByVectorAnn,
  searchChunksByVectorExact,
} from "../retrieval/repository";
import { MAX_VECTOR_DIMENSIONS, VECTOR_DISTANCE_OPS } from "./constants";
import type {
  VectorAnnSearchInput,
  VectorSearchInput,
  VectorSearchProvider,
} from "./provider";

class PgVectorProvider implements VectorSearchProvider {
  readonly capabilities = {
    kind: "pgvector" as const,
    maxAnnDimensions: MAX_VECTOR_DIMENSIONS,
    supportsAnn: true,
    distanceOps: VECTOR_DISTANCE_OPS,
  };

  validateDimensions(dimensions: number | null) {
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

  supportsAnn(dimensions: number | null): dimensions is number {
    return (
      this.capabilities.supportsAnn &&
      dimensions !== null &&
      dimensions <= this.capabilities.maxAnnDimensions
    );
  }

  async searchExact(input: VectorSearchInput) {
    return searchChunksByVectorExact(input);
  }

  async searchAnn(input: VectorAnnSearchInput) {
    this.validateDimensions(input.dim);
    return searchChunksByVectorAnn(input);
  }
}

export const vectorSearchProvider: VectorSearchProvider = new PgVectorProvider();

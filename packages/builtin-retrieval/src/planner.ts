import type { RetrievalPlannerResult } from "./types";

export function planRetrievalStrategy(input: {
  vectorStrategy: string;
  dimensions: number | null;
  resolveAnnIndex: (dimensions: number) => string | null;
  validateDimensions?: (dimensions: number | null) => void;
  supportsAnn?: (dimensions: number) => boolean;
}): RetrievalPlannerResult {
  if (input.validateDimensions) {
    input.validateDimensions(input.dimensions);
  }

  if (input.vectorStrategy === "disabled") {
    return {
      strategy: "bm25_only",
      annIndexUsed: null,
      requestedDimensions: input.dimensions,
    };
  }

  if (input.vectorStrategy === "exact") {
    return {
      strategy: "exact_vector",
      annIndexUsed: null,
      requestedDimensions: input.dimensions,
    };
  }

  if (input.dimensions !== null) {
    const annIndex = input.resolveAnnIndex(input.dimensions);
    if (annIndex && (input.supportsAnn?.(input.dimensions) ?? true)) {
      return {
        strategy: "ann_hnsw",
        annIndexUsed: annIndex,
        requestedDimensions: input.dimensions,
      };
    }
  }

  return {
    strategy: "exact_vector",
    annIndexUsed: null,
    requestedDimensions: input.dimensions,
  };
}

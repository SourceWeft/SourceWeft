import { vectorSearchProvider as pgvectorSearchProvider } from "./pgvector-provider";
import type { VectorSearchProvider } from "./provider";

export const vectorSearchProvider: VectorSearchProvider =
  pgvectorSearchProvider;

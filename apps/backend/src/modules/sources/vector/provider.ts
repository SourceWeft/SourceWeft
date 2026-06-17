import type { RetrievalCandidate } from "./types";

export type VectorDistanceOp = "cosine";

export type VectorProviderCapabilities = {
  kind: "pgvector";
  maxAnnDimensions: number;
  supportsAnn: boolean;
  distanceOps: readonly VectorDistanceOp[];
};

export type VectorSearchInput = {
  teamId: string;
  workspaceId: string;
  embeddingProfileId: string;
  queryEmbedding: number[];
  topK: number;
  sourceIds: string[];
};

export type VectorAnnSearchInput = VectorSearchInput & {
  dim: number;
};

export interface VectorSearchProvider {
  readonly capabilities: VectorProviderCapabilities;
  validateDimensions(dimensions: number | null): void;
  supportsAnn(dimensions: number | null): dimensions is number;
  searchExact(input: VectorSearchInput): Promise<RetrievalCandidate[]>;
  searchAnn(input: VectorAnnSearchInput): Promise<RetrievalCandidate[]>;
}

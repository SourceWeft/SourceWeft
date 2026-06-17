export type EmbeddingVectorStrategy = "ann_hnsw" | "exact_vector" | "bm25_only";

export type RetrievalCandidateStage = "bm25" | "vector";

export type RetrievalContextRole = "primary" | "neighbor" | "small_document";

export type RetrievalCandidate = {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly chunkNo: number;
  readonly content: string;
  readonly score: number;
  readonly stage: RetrievalCandidateStage;
  readonly stages?: readonly RetrievalCandidateStage[];
  readonly contextRole?: RetrievalContextRole;
  readonly primaryChunkId?: string;
};

export type RetrievalPlannerResult = {
  readonly strategy: EmbeddingVectorStrategy;
  readonly annIndexUsed: string | null;
  readonly requestedDimensions: number | null;
};

export type ContextAssemblyMetadata = {
  readonly primaryCandidateCount: number;
  readonly assembledChunkCount: number;
  readonly expandedNeighborCount: number;
  readonly smallDocumentCount: number;
  readonly finalContextChars: number;
  readonly documentCount: number;
  readonly contextTruncated: boolean;
};

export type RetrievalDocumentChunk = {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly chunkNo: number;
  readonly content: string;
};

export type RetrievalDocumentChunkStats = {
  readonly documentId: string;
  readonly sourceId: string;
  readonly chunkCount: number;
  readonly totalChars: number;
};

import type {
  RetrievalCandidate,
  RetrievalDocumentChunk,
  RetrievalDocumentChunkStats,
  RetrievalPlannerResult,
} from "./types";

// ── Domain types ────────────────────────────────────────────────────────────

export interface EmbeddingProfile {
  readonly id: string;
  readonly profileAlias: string;
  readonly gatewayConfigId: string;
  readonly modelAlias: string;
  readonly requestedDimensions: number | null;
  readonly vectorStrategy: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface SourceChunkEmbedding {
  readonly embedding: number[] | null;
  readonly dim: number | null;
  readonly modelAlias: string | null;
  readonly embeddingId: string;
  readonly chunk: {
    readonly id: string;
    readonly teamId: string;
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly documentId: string;
    readonly chunkNo: number;
    readonly content: string;
  };
}

// ── Data access interface ───────────────────────────────────────────────────

export interface RetrievalDataAccess {
  findDefaultEmbeddingProfile(): Promise<EmbeddingProfile | null>;

  listSourceChunksByProfile(input: {
    teamId: string;
    workspaceId: string;
    embeddingProfileId: string;
    sourceIds?: string[];
  }): Promise<readonly SourceChunkEmbedding[]>;

  searchChunksByBm25(input: {
    teamId: string;
    workspaceId: string;
    queryText: string;
    topK: number;
    sourceIds: string[];
  }): Promise<readonly RetrievalCandidate[]>;

  searchChunksByVectorExact(input: {
    teamId: string;
    workspaceId: string;
    embeddingProfileId: string;
    queryEmbedding: number[];
    topK: number;
    sourceIds: string[];
  }): Promise<readonly RetrievalCandidate[]>;

  searchChunksByVectorAnn(input: {
    teamId: string;
    workspaceId: string;
    embeddingProfileId: string;
    queryEmbedding: number[];
    dim: number;
    topK: number;
    sourceIds: string[];
  }): Promise<readonly RetrievalCandidate[]>;

  listDocumentChunkStats(input: {
    teamId: string;
    workspaceId: string;
    documents: ReadonlyArray<{
      readonly documentId: string;
      readonly sourceId: string;
    }>;
  }): Promise<readonly RetrievalDocumentChunkStats[]>;

  listDocumentChunksInRange(input: {
    teamId: string;
    workspaceId: string;
    documentId: string;
    sourceId: string;
    startChunkNo: number;
    endChunkNo: number;
  }): Promise<readonly RetrievalDocumentChunk[]>;

  listDocumentChunksForDocument(input: {
    teamId: string;
    workspaceId: string;
    documentId: string;
    sourceId: string;
    limit: number;
  }): Promise<readonly RetrievalDocumentChunk[]>;

  createRetrievalRun(input: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    messageId: string;
    embeddingProfileId: string | null;
    queryText: string;
    embedModelAlias: string | null;
    rerankModelAlias: string | null;
    vectorStrategyUsed: RetrievalPlannerResult["strategy"];
    annIndexUsed?: string | null;
    bm25TopK?: number | null;
    vectorTopK?: number | null;
    rrfK?: number | null;
    prefilterCount?: number | null;
    candidateCount?: number | null;
    finalResultCount?: number | null;
    latencyMs?: number | null;
    metadataJson?: Record<string, unknown>;
  }): Promise<string>;

  createRetrievalHits(input: {
    runId: string;
    hits: ReadonlyArray<{
      readonly sourceStage: "bm25" | "vector" | "rrf" | "rerank";
      readonly hitType: "chunk" | "document";
      readonly sourceId?: string | null;
      readonly documentId?: string | null;
      readonly chunkId?: string | null;
      readonly rank: number;
      readonly score: number;
    }>;
  }): Promise<void>;
}

// ── Embedding gateway ───────────────────────────────────────────────────────

export interface RetrievalEmbeddingGateway {
  embed(input: {
    queryText: string;
    dimensions: number;
    modelAlias: string;
    gatewayConfigId: string;
  }): Promise<number[]>;
}

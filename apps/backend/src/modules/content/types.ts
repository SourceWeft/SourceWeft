export type EmbeddingVectorStrategy =
  | "ann_hnsw"
  | "exact_vector"
  | "bm25_only"
  | "bm25_prefilter_exact";

export type EmbeddingProfileRecord = {
  id: string;
  alias: string;
  providerKind: "litellm";
  providerModelAlias: string;
  requestedDimensions: number | null;
  vectorStrategy: "auto" | "exact" | "disabled";
  isDefault: boolean;
  isActive: boolean;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ChunkRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  sourceId: string;
  documentId: string;
  chunkNo: number;
  content: string;
  headingPath: string | null;
  startOffset: number | null;
  endOffset: number | null;
  language: string | null;
  chunkMetadata: Record<string, unknown>;
  createdAt: string;
};

export type SourceStatus =
  | "created"
  | "queued"
  | "processing"
  | "indexed"
  | "failed"
  | "archived";

export type SourceRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  title: string;
  contentText: string;
  status: SourceStatus;
  estimatedPages: number | null;
  parsedTokens: number | null;
  createdBy: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceDocumentRecord = {
  id: string;
  title: string | null;
  language: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  tokenCount: number | null;
  charCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceChunkRecord = {
  id: string;
  documentId: string;
  chunkNo: number;
  content: string;
  headingPath: string | null;
  startOffset: number | null;
  endOffset: number | null;
  language: string | null;
  createdAt: string;
};

export type SourceEmbeddingRecord = {
  id: string;
  chunkId: string;
  embeddingProfileId: string;
  modelAlias: string;
  dim: number;
  createdAt: string;
};

export type SourceDetailRecord = {
  source: SourceRecord;
  documents: SourceDocumentRecord[];
  chunks: SourceChunkRecord[];
  embeddings: SourceEmbeddingRecord[];
};

export type ThreadRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdBy: string | null;
  model: string | null;
  creditsConsumed: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

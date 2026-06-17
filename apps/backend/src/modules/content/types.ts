import {
  sourceSchema,
  sourceStatusResponseSchema,
  type ThreadChatPreferences,
} from "@sourceweft/contracts";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Re-exports from shared packages (canonical definitions)
// ---------------------------------------------------------------------------

import type {
  ChunkSpec,
  DocumentParseMode,
  DocumentParseProviderId,
  DocumentParseStrategy,
  ParsingConfig,
  SourceMetadata,
} from "@sourceweft/builtin-document-parsers";

export type {
  ChunkSpec,
  DocumentParseMode,
  DocumentParseProviderId,
  DocumentParseStrategy,
  ParsingConfig,
  SourceMetadata,
};

// ---------------------------------------------------------------------------
// Derived from @sourceweft/contracts Zod schemas
// ---------------------------------------------------------------------------

export type SourceStatus = z.infer<typeof sourceSchema.shape.status>;
export type SourceType = z.infer<typeof sourceSchema.shape.sourceType>;
export type SourceStatusStep = z.infer<
  typeof sourceStatusResponseSchema.shape.currentStep
>;

// ---------------------------------------------------------------------------
// Backend-specific types (not present in shared packages)
// ---------------------------------------------------------------------------

export type EmbeddingVectorStrategy = "ann_hnsw" | "exact_vector" | "bm25_only";

export type EmbeddingProfileRecord = {
  id: string;
  kind: "embedding";
  profileAlias: string;
  gatewayConfigId: string;
  modelAlias: string;
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

export type SourceStatusDetail = {
  status: SourceStatus;
  progress: number;
  currentStep: SourceStatusStep;
  parsedPages: number | null;
  totalPages: number | null;
  error: string | null;
  jobId: string | null;
};

export type SourceRevisionRecord = {
  id: string;
  sourceId: string;
  revisionNo: number;
  contentHash: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  parserVersion: string | null;
  isLatest: boolean;
  createdAt: string;
};

export type SourceRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  ingestKind:
    | "connector"
    | "manual_upload"
    | "web_url"
    | "youtube"
    | "note"
    | "artifact";
  sourceType: SourceType;
  connectorId: string | null;
  syncRunId: string | null;
  parentSourceId: string | null;
  title: string;
  contentText: string;
  externalId: string | null;
  externalUri: string | null;
  externalUpdatedAt: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  status: SourceStatus;
  estimatedPages: number | null;
  parsedTokens: number | null;
  parserVersion: string | null;
  parsingConfig: ParsingConfig | null;
  metadata: SourceMetadata;
  error: Record<string, unknown>;
  createdBy: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceDocumentRecord = {
  id: string;
  title: string | null;
  language: string | null;
  contentText: string;
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
  revisions: SourceRevisionRecord[];
};

export type ThreadRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  title: string;
  modelSettings: {
    llmProfileAlias: string | null;
    imageProfileAlias: string | null;
    visionProfileAlias: string | null;
    llmModelAlias: string | null;
    imageModelAlias: string | null;
    visionModelAlias: string | null;
  };
  chatPreferences: ThreadChatPreferences;
  sourceCount: number;
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
  parentMessageId: string | null;
  role: MessageRole;
  content: string;
  createdBy: string | null;
  model: string | null;
  creditsConsumed: number | null;
  contentJson: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type WorkingFilePurpose = "scratch" | "draft" | "note" | "output_candidate";

export type WorkingFileRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  purpose: WorkingFilePurpose | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Model gateway profile kind — used by content and threads for billing & catalog
// ---------------------------------------------------------------------------

export type ModelProfileKind =
  | "chat"
  | "image"
  | "vision"
  | "video"
  | "asr"
  | "tts"
  | "embedding"
  | "rerank";

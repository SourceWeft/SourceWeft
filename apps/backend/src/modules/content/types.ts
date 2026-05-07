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

export type SourceStatus =
  | "created"
  | "queued"
  | "processing"
  | "indexed"
  | "failed"
  | "archived";

export type SourceType =
  | "manual_upload"
  | "file_upload"
  | "web_url"
  | "youtube"
  | "note"
  | "artifact"
  | "connector"
  | "directory";

export type ParsingConfig = {
  chunkSize: number;
  parserVersion: string;
};

export type DocumentParseProviderId =
  | "langchain"
  | "pdf2markdown"
  | "docling"
  | "llamaparse"
  | "unstructured";

export type DocumentParseStrategy =
  | "explicit"
  | "balanced"
  | "cost"
  | "quality";

export type DocumentParseMode =
  | "pure_text_pdf"
  | "ocr_pdf"
  | "image_ocr"
  | "generic";

export type ChunkSpec = {
  text: string;
  startIndex: number;
  endIndex: number;
  tokenCount: number;
  embedding?: number[];
};

export type SourceMetadata = {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  pageCount?: number;
  wordCount?: number;
  charCount?: number;
  extractedAt?: string;
  uploadMethod?: "manual" | "api";
  documentParseStrategy?: DocumentParseStrategy;
  documentParseProvider?: DocumentParseProviderId;
  documentParseBackend?: DocumentParseProviderId;
  documentParseProviderRequested?: DocumentParseProviderId;
  documentParseProviderResolved?: DocumentParseProviderId;
  documentParseMode?: DocumentParseMode;
  providerTaskId?: string;
  providerStatus?: string;
  providerAttempts?: number;
  providerUpdatedAt?: string;
  pdfClassification?: "pure_text" | "non_pure_text";
  pdfClassificationConfidence?: number;
  pdfBitmapCoverageSummary?: {
    min: number;
    max: number;
    avg: number;
  };
  [key: string]: unknown;
};

export type SourceStatusStep =
  | "created"
  | "uploading"
  | "queued"
  | "parsing"
  | "chunking"
  | "embedding"
  | "completed"
  | "failed";

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
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ByokKeyRefRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  providerName: string;
  keyRef: string;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

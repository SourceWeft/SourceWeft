import { z } from "zod";
import {
  billingSummaryResponseSchema,
  meterConsumeResponseSchema,
  meterIngestionResponseSchema,
} from "./billing";

const retrievalVectorStrategySchema = z.enum([
  "ann_hnsw",
  "exact_vector",
  "bm25_only",
]);

const retrievalCitationSchema = z.object({
  citation: z.string().min(1),
  sourceId: z.string(),
  sourceTitle: z.string().optional(),
  documentId: z.string(),
  chunkId: z.string(),
  chunkNo: z.number().int().nonnegative().optional(),
  score: z.number(),
  excerpt: z.string(),
});

const retrievalResponseSchema = z.object({
  embeddingProfileId: z.string().nullable(),
  vectorStrategy: retrievalVectorStrategySchema.nullable(),
  annIndexUsed: z.string().nullable(),
  citations: z.array(retrievalCitationSchema),
  availableCitations: z.array(retrievalCitationSchema).optional(),
});

const sourceDocumentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  language: z.string().nullable(),
  contentText: z.string(),
  status: z.enum(["pending", "processing", "ready", "failed"]),
  tokenCount: z.number().int().nonnegative().nullable(),
  charCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sourceChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  chunkNo: z.number().int().nonnegative(),
  content: z.string(),
  headingPath: z.string().nullable(),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().nonnegative().nullable(),
  language: z.string().nullable(),
  createdAt: z.string(),
});

const sourceEmbeddingSchema = z.object({
  id: z.string(),
  chunkId: z.string(),
  embeddingProfileId: z.string(),
  modelAlias: z.string(),
  dim: z.number().int().positive(),
  createdAt: z.string(),
});

export const sourceSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  ingestKind: z.enum([
    "connector",
    "manual_upload",
    "web_url",
    "youtube",
    "note",
    "artifact",
  ]),
  sourceType: z.enum([
    "manual_upload",
    "file_upload",
    "web_url",
    "youtube",
    "note",
    "artifact",
    "connector",
  ]),
  title: z.string(),
  contentText: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  contentHash: z.string().nullable(),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  status: z.enum([
    "created",
    "queued",
    "processing",
    "indexed",
    "failed",
    "archived",
  ]),
  estimatedPages: z.number().int().positive().nullable(),
  parsedTokens: z.number().int().positive().nullable(),
  parserVersion: z.string().nullable(),
  parsingConfig: z
    .object({
      chunkSize: z.number().int().positive(),
      parserVersion: z.string(),
    })
    .nullable(),
  metadata: z.record(z.string(), z.unknown()),
  error: z.record(z.string(), z.unknown()),
  createdBy: z.string().nullable(),
  indexedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sourceRevisionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  revisionNo: z.number().int().positive(),
  contentHash: z.string().nullable(),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  parserVersion: z.string().nullable(),
  isLatest: z.boolean(),
  createdAt: z.string(),
});

export const sourceStatusResponseSchema = z.object({
  status: sourceSchema.shape.status,
  progress: z.number().min(0).max(100),
  currentStep: z.enum([
    "created",
    "uploading",
    "queued",
    "parsing",
    "chunking",
    "embedding",
    "completed",
    "failed",
  ]),
  parsedPages: z.number().int().nonnegative().nullable(),
  totalPages: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  jobId: z.string().nullable(),
});

export const uploadSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

export const reparseSourceRequestSchema = z.object({
  chunkSize: z.number().int().positive().max(8192).optional(),
});

export const reparseSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
  revision: sourceRevisionSchema,
});

export const sourceContentResponseSchema = z.object({
  source: sourceSchema,
  content: z.string(),
});

export const createSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().max(100000).optional(),
  estimatedPages: z.number().int().positive().optional(),
  parsedTokens: z.number().int().positive().optional(),
});

export const createSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const listSourcesResponseSchema = z.object({
  items: z.array(sourceSchema),
});

export const getSourceResponseSchema = z.object({
  source: sourceSchema,
  documents: z.array(sourceDocumentSchema),
  chunks: z.array(sourceChunkSchema),
  embeddings: z.array(sourceEmbeddingSchema),
  revisions: z.array(sourceRevisionSchema),
});

export const getSourceDocumentResponseSchema = getSourceResponseSchema;

export const updateSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().max(100000).optional(),
  estimatedPages: z.number().int().positive().nullable().optional(),
  parsedTokens: z.number().int().positive().nullable().optional(),
});

export const updateSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const deleteSourceResponseSchema = z.object({
  deleted: z.literal(true),
  sourceId: z.string(),
});

export const indexSourceRequestSchema = z.object({
  estimatedPages: z.number().int().positive().optional(),
  parsedTokens: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
});

export const indexSourceResponseSchema = z.object({
  source: sourceSchema,
  billing: meterIngestionResponseSchema,
  indexing: z.object({
    chunkCount: z.number().int().nonnegative(),
    embeddingProfileId: z.string(),
    vectorStrategy: retrievalVectorStrategySchema,
    annIndexUsed: z.string().nullable(),
  }),
});

export const threadSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  modelSettings: z.object({
    llmModelAlias: z.string().nullable(),
    imageModelAlias: z.string().nullable(),
    visionModelAlias: z.string().nullable(),
  }),
  sourceCount: z.number().int().nonnegative(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const threadModelSettingsInputSchema = z.object({
  llmModelAlias: z.string().trim().min(1).max(512).nullable().optional(),
  imageModelAlias: z.string().trim().min(1).max(512).nullable().optional(),
  visionModelAlias: z.string().trim().min(1).max(512).nullable().optional(),
});

export const threadModelSettingsPatchSchema =
  threadModelSettingsInputSchema.refine(
    (value) =>
      value.llmModelAlias !== undefined ||
      value.imageModelAlias !== undefined ||
      value.visionModelAlias !== undefined,
    { message: "At least one model alias must be provided" },
  );

export const createThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  modelSettings: threadModelSettingsInputSchema.optional(),
});

export const createThreadResponseSchema = z.object({
  thread: threadSchema,
});

export const getThreadResponseSchema = z.object({
  thread: threadSchema,
});

export const deleteThreadResponseSchema = z.object({
  deleted: z.literal(true),
  threadId: z.string(),
});

export const listThreadsRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(1024).optional(),
});

export const listThreadsResponseSchema = z.object({
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

export const messageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  parentMessageId: z.string().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdBy: z.string().nullable(),
  model: z.string().nullable(),
  creditsConsumed: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const byokConfigSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  apiKeyRef: z.string().trim().min(1).max(256),
});

const llmExecutionConfigSchema = z.object({
  modelAlias: z.string().trim().min(1).max(512).optional(),
  executionMode: z.enum(["GLOBAL", "BYOK"]).optional(),
  providerHint: z.string().trim().min(1).max(100).optional(),
  byok: byokConfigSchema.optional(),
});

export const streamThreadModeSchema = z.enum(["send", "refresh", "edit"]);

export const streamThreadRequestSchema = z.object({
  mode: streamThreadModeSchema.optional(),
  content: z.string().trim().min(1).max(20000).optional(),
  sourceIds: z.array(z.string()).max(100).optional(),
  stream: z.boolean().optional(),
  userMessageId: z.string().trim().min(1).max(128).optional(),
  assistantMessageId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
  llm: llmExecutionConfigSchema.optional(),
});

export const refreshThreadRequestSchema = streamThreadRequestSchema;

export const editThreadRequestSchema = streamThreadRequestSchema;

export const streamThreadResponseSchema = z.object({
  thread: threadSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema,
  billing: meterConsumeResponseSchema,
  retrieval: retrievalResponseSchema,
});

export const refreshThreadResponseSchema = streamThreadResponseSchema;
export const editThreadResponseSchema = streamThreadResponseSchema;

export const listThreadMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
});

export const updateThreadModelSettingsRequestSchema =
  threadModelSettingsPatchSchema;

export const updateThreadModelSettingsResponseSchema = z.object({
  thread: threadSchema,
});

const modelCatalogKindSchema = z.enum(["llm", "image", "vision"]);

export const modelCatalogItemSchema = z.object({
  kind: modelCatalogKindSchema,
  profileAlias: z.string(),
  modelAlias: z.string(),
  providerName: z.string(),
  providerKind: z.string(),
  targetModel: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  displayName: z.string(),
  subtitle: z.string(),
  badges: z.array(z.string()),
  pricing: z.record(z.string(), z.unknown()).nullable(),
});

export const listThreadModelCatalogResponseSchema = z.object({
  defaults: threadSchema.shape.modelSettings,
  kinds: z.object({
    llm: z.array(modelCatalogItemSchema),
    image: z.array(modelCatalogItemSchema),
    vision: z.array(modelCatalogItemSchema),
  }),
});

export const byokKeyRefSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string().nullable(),
  providerName: z.string(),
  keyRef: z.string(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listByokKeyRefsResponseSchema = z.object({
  items: z.array(byokKeyRefSchema),
});

export const createByokKeyRefRequestSchema = z.object({
  providerName: z.string().trim().min(1).max(100),
  keyRef: z.string().trim().min(1).max(256),
  apiKey: z.string().trim().min(1).max(4096),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createByokKeyRefResponseSchema = z.object({
  item: byokKeyRefSchema,
});

export const deleteByokKeyRefResponseSchema = z.object({
  deleted: z.literal(true),
  keyRef: z.string(),
});

export const citationDetailResponseSchema = z.object({
  citation: retrievalCitationSchema,
});

export const billingDashboardResponseSchema = z.object({
  summary: billingSummaryResponseSchema,
});

export type Source = z.infer<typeof sourceSchema>;
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;
export type ListSourcesResponse = z.infer<typeof listSourcesResponseSchema>;
export type GetSourceResponse = z.infer<typeof getSourceResponseSchema>;
export type GetSourceDocumentResponse = z.infer<
  typeof getSourceDocumentResponseSchema
>;
export type SourceStatusResponse = z.infer<typeof sourceStatusResponseSchema>;
export type UploadSourceResponse = z.infer<typeof uploadSourceResponseSchema>;
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;
export type UpdateSourceResponse = z.infer<typeof updateSourceResponseSchema>;
export type DeleteSourceResponse = z.infer<typeof deleteSourceResponseSchema>;
export type ReparseSourceRequest = z.infer<typeof reparseSourceRequestSchema>;
export type ReparseSourceResponse = z.infer<typeof reparseSourceResponseSchema>;
export type SourceContentResponse = z.infer<typeof sourceContentResponseSchema>;
export type IndexSourceRequest = z.infer<typeof indexSourceRequestSchema>;
export type IndexSourceResponse = z.infer<typeof indexSourceResponseSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ThreadModelSettingsPatch = z.infer<
  typeof threadModelSettingsPatchSchema
>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type GetThreadResponse = z.infer<typeof getThreadResponseSchema>;
export type DeleteThreadResponse = z.infer<typeof deleteThreadResponseSchema>;
export type ListThreadsRequest = z.infer<typeof listThreadsRequestSchema>;
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;
export type Message = z.infer<typeof messageSchema>;
export type StreamThreadMode = z.infer<typeof streamThreadModeSchema>;
export type StreamThreadRequest = z.infer<typeof streamThreadRequestSchema>;
export type StreamThreadResponse = z.infer<typeof streamThreadResponseSchema>;
export type RefreshThreadRequest = z.infer<typeof refreshThreadRequestSchema>;
export type RefreshThreadResponse = z.infer<typeof refreshThreadResponseSchema>;
export type EditThreadRequest = z.infer<typeof editThreadRequestSchema>;
export type EditThreadResponse = z.infer<typeof editThreadResponseSchema>;
export type ListThreadMessagesResponse = z.infer<
  typeof listThreadMessagesResponseSchema
>;
export type UpdateThreadModelSettingsRequest = z.infer<
  typeof updateThreadModelSettingsRequestSchema
>;
export type UpdateThreadModelSettingsResponse = z.infer<
  typeof updateThreadModelSettingsResponseSchema
>;
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ListThreadModelCatalogResponse = z.infer<
  typeof listThreadModelCatalogResponseSchema
>;

export type ByokKeyRef = z.infer<typeof byokKeyRefSchema>;
export type ListByokKeyRefsResponse = z.infer<
  typeof listByokKeyRefsResponseSchema
>;
export type CreateByokKeyRefRequest = z.infer<
  typeof createByokKeyRefRequestSchema
>;
export type CreateByokKeyRefResponse = z.infer<
  typeof createByokKeyRefResponseSchema
>;
export type DeleteByokKeyRefResponse = z.infer<
  typeof deleteByokKeyRefResponseSchema
>;
export type CitationDetailResponse = z.infer<typeof citationDetailResponseSchema>;

import { z } from "zod";
import { meterIngestionResponseSchema } from "./billing";

const retrievalVectorStrategySchema = z.enum([
  "ann_hnsw",
  "exact_vector",
  "bm25_only",
]);

/** Shared with the sources table in @sourceweft/db. */
export const sourceStatusSchema = z.enum([
  "created",
  "queued",
  "processing",
  "indexed",
  "failed",
  "archived",
]);

export const sourceIngestKindSchema = z.enum([
  "connector",
  "manual_upload",
  "web_url",
  "youtube",
  "note",
  "artifact",
]);

export const sourceTypeSchema = z.enum([
  "manual_upload",
  "file_upload",
  "web_url",
  "youtube",
  "note",
  "artifact",
  "connector",
  "directory",
]);

export const sourceDocumentStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
]);

export const retrievalCitationSchema = z.object({
  citation: z.string().min(1),
  sourceId: z.string().nullable(),
  sourceTitle: z.string().optional(),
  documentId: z.string().nullable(),
  chunkId: z.string(),
  chunkNo: z.number().int().nonnegative().optional(),
  score: z.number(),
  excerpt: z.string(),
  externalUri: z.string().url().optional(),
});

export const retrievalResponseSchema = z.object({
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
  status: sourceDocumentStatusSchema,
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
  ingestKind: sourceIngestKindSchema,
  sourceType: sourceTypeSchema,
  connectorId: z.string().nullable(),
  syncRunId: z.string().nullable(),
  parentSourceId: z.string().nullable(),
  title: z.string(),
  contentText: z.string(),
  externalId: z.string().nullable(),
  externalUri: z.string().nullable(),
  externalUpdatedAt: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  contentHash: z.string().nullable(),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  previewUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  status: sourceStatusSchema,
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

export const listSourceStatusesRequestSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(100),
});

export const listSourceStatusesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: sourceStatusResponseSchema,
    }),
  ),
});

export const bulkDeleteSourcesRequestSchema = z.object({
  sourceIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

export const bulkDeleteSourcesResponseSchema = z.object({
  deleted: z.literal(true),
  sourceIds: z.array(z.string()),
  deletedCount: z.number().int().nonnegative(),
});

export const uploadSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

/**
 * The one upload ceiling, shared by the browser's pre-flight check and the
 * server's enforcement.
 *
 * On the direct-upload path the client PUTs straight to the object store, so
 * the browser-side check is a courtesy that stops a doomed transfer early — it
 * is not a control. The server re-applies this same number to the size the
 * store reports at completion, which is the only measurement that binds.
 */
export const SOURCE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export const createSourceUploadIntentRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(SOURCE_UPLOAD_MAX_BYTES),
  parentSourceId: z.string().nullish(),
});

/**
 * The intent response is where the deployment tells the client which upload
 * path it offers, rather than the client guessing from build-time config.
 *
 * That indirection is what keeps a self-hosted install zero-configuration: the
 * bucket-side CORS policy a browser needs for a presigned PUT is an
 * operator-only step, so a deployment that has not taken it answers `proxy` and
 * the client transparently posts the file to the API instead.
 */
export const createSourceUploadIntentResponseSchema = z.discriminatedUnion(
  "mode",
  [
    z.object({
      mode: z.literal("direct"),
      sourceId: z.string(),
      /**
       * The presigned PUT target. The client must send `Content-Type:
       * contentType` verbatim — the header is part of what the server signed,
       * so any other value is rejected by the store rather than stored.
       */
      uploadUrl: z.string(),
      contentType: z.string(),
      expiresAt: z.string(),
    }),
    z.object({
      mode: z.literal("proxy"),
    }),
  ],
);

export const completeSourceUploadResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

export const reparseSourceRequestSchema = z.object({
  chunkSize: z.number().int().positive().max(8192).optional(),
  forceRefresh: z.boolean().optional(),
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
  sourceType: z
    .enum([
      "manual_upload",
      "file_upload",
      "web_url",
      "youtube",
      "note",
      "artifact",
      "connector",
      "directory",
    ])
    .optional(),
  parentSourceId: z.string().nullable().optional(),
});

export const createSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const createUrlSourceRequestSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  title: z.string().trim().min(1).max(200).optional(),
  parentSourceId: z.string().nullable().optional(),
  forceRefresh: z.boolean().optional(),
});

export const createUrlSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

export const listSourcesResponseSchema = z.object({
  items: z.array(sourceSchema),
  nextCursor: z.string().nullable().optional(),
});

export const listSourcesRequestSchema = z.object({
  view: z.enum(["tree", "page"]).optional(),
  includeContent: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(1024).optional(),
  parentSourceId: z.string().trim().min(1).nullable().optional(),
  connectorId: z.string().trim().min(1).optional(),
  syncRunId: z.string().trim().min(1).optional(),
  updatedAfter: z.string().datetime().optional(),
});

const sourceMentionSchema = sourceSchema.pick({
  id: true,
  title: true,
  sourceType: true,
  parentSourceId: true,
  mimeType: true,
  status: true,
  storageKey: true,
  updatedAt: true,
});

export const listSourceMentionsRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export const listSourceMentionsResponseSchema = z.object({
  items: z.array(sourceMentionSchema),
  nextCursor: z.string().nullable(),
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
  parentSourceId: z.string().nullable().optional(),
});

export const updateSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const deleteSourceResponseSchema = z.object({
  deleted: z.literal(true),
  sourceId: z.string(),
});

export const indexSourceRequestSchema = z.object({
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

export const retrySourceRequestSchema = z.object({
  chunkSize: z.number().int().positive().max(8192).optional(),
  forceRefresh: z.boolean().optional(),
});

export const retrySourceResponseSchema = z.discriminatedUnion("mode", [
  reparseSourceResponseSchema.extend({
    mode: z.literal("reparse"),
  }),
  indexSourceResponseSchema.extend({
    mode: z.literal("index"),
  }),
]);

export type Source = z.infer<typeof sourceSchema>;
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;
export type CreateUrlSourceRequest = z.infer<
  typeof createUrlSourceRequestSchema
>;
export type CreateUrlSourceResponse = z.infer<
  typeof createUrlSourceResponseSchema
>;
export type ListSourcesResponse = z.infer<typeof listSourcesResponseSchema>;
export type ListSourcesRequest = z.infer<typeof listSourcesRequestSchema>;
export type SourceMention = z.infer<typeof sourceMentionSchema>;
export type ListSourceMentionsRequest = z.infer<
  typeof listSourceMentionsRequestSchema
>;
export type ListSourceMentionsResponse = z.infer<
  typeof listSourceMentionsResponseSchema
>;
export type GetSourceResponse = z.infer<typeof getSourceResponseSchema>;
export type GetSourceDocumentResponse = z.infer<
  typeof getSourceDocumentResponseSchema
>;
export type SourceStatusResponse = z.infer<typeof sourceStatusResponseSchema>;
export type ListSourceStatusesRequest = z.infer<
  typeof listSourceStatusesRequestSchema
>;
export type ListSourceStatusesResponse = z.infer<
  typeof listSourceStatusesResponseSchema
>;
export type BulkDeleteSourcesRequest = z.infer<
  typeof bulkDeleteSourcesRequestSchema
>;
export type BulkDeleteSourcesResponse = z.infer<
  typeof bulkDeleteSourcesResponseSchema
>;
export type UploadSourceResponse = z.infer<typeof uploadSourceResponseSchema>;
export type CreateSourceUploadIntentRequest = z.infer<
  typeof createSourceUploadIntentRequestSchema
>;
export type CreateSourceUploadIntentResponse = z.infer<
  typeof createSourceUploadIntentResponseSchema
>;
export type CompleteSourceUploadResponse = z.infer<
  typeof completeSourceUploadResponseSchema
>;
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;
export type UpdateSourceResponse = z.infer<typeof updateSourceResponseSchema>;
export type DeleteSourceResponse = z.infer<typeof deleteSourceResponseSchema>;
export type ReparseSourceRequest = z.infer<typeof reparseSourceRequestSchema>;
export type ReparseSourceResponse = z.infer<typeof reparseSourceResponseSchema>;
export type RetrySourceRequest = z.infer<typeof retrySourceRequestSchema>;
export type RetrySourceResponse = z.infer<typeof retrySourceResponseSchema>;
export type SourceContentResponse = z.infer<typeof sourceContentResponseSchema>;
export type IndexSourceRequest = z.infer<typeof indexSourceRequestSchema>;
export type IndexSourceResponse = z.infer<typeof indexSourceResponseSchema>;

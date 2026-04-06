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
  "bm25_prefilter_exact",
]);

const retrievalCitationSchema = z.object({
  citation: z.number().int().positive(),
  sourceId: z.string(),
  documentId: z.string(),
  chunkId: z.string(),
  score: z.number(),
  excerpt: z.string(),
});

const retrievalResponseSchema = z.object({
  embeddingProfileId: z.string(),
  vectorStrategy: retrievalVectorStrategySchema,
  annIndexUsed: z.string().nullable(),
  citations: z.array(retrievalCitationSchema),
});

const sourceDocumentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  language: z.string().nullable(),
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
  title: z.string(),
  contentText: z.string(),
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
  createdBy: z.string().nullable(),
  indexedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
});

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

export const threadSourceSchema = z.object({
  source: sourceSchema,
  selectedAt: z.string(),
  selectedBy: z.string().nullable(),
});

export const listThreadSourcesResponseSchema = z.object({
  items: z.array(threadSourceSchema),
});

export const setThreadSourcesRequestSchema = z.object({
  sourceIds: z.array(z.string()).max(100),
});

export const setThreadSourcesResponseSchema = z.object({
  items: z.array(threadSourceSchema),
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
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const createThreadResponseSchema = z.object({
  thread: threadSchema,
});

export const messageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdBy: z.string().nullable(),
  model: z.string().nullable(),
  creditsConsumed: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const streamThreadRequestSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
});

export const streamThreadResponseSchema = z.object({
  thread: threadSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema,
  billing: meterConsumeResponseSchema,
  retrieval: retrievalResponseSchema,
});

export const billingDashboardResponseSchema = z.object({
  summary: billingSummaryResponseSchema,
});

export type Source = z.infer<typeof sourceSchema>;
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;
export type ListSourcesResponse = z.infer<typeof listSourcesResponseSchema>;
export type GetSourceResponse = z.infer<typeof getSourceResponseSchema>;
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;
export type UpdateSourceResponse = z.infer<typeof updateSourceResponseSchema>;
export type DeleteSourceResponse = z.infer<typeof deleteSourceResponseSchema>;
export type ThreadSource = z.infer<typeof threadSourceSchema>;
export type ListThreadSourcesResponse = z.infer<
  typeof listThreadSourcesResponseSchema
>;
export type SetThreadSourcesRequest = z.infer<
  typeof setThreadSourcesRequestSchema
>;
export type SetThreadSourcesResponse = z.infer<
  typeof setThreadSourcesResponseSchema
>;
export type IndexSourceRequest = z.infer<typeof indexSourceRequestSchema>;
export type IndexSourceResponse = z.infer<typeof indexSourceResponseSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type Message = z.infer<typeof messageSchema>;
export type StreamThreadRequest = z.infer<typeof streamThreadRequestSchema>;
export type StreamThreadResponse = z.infer<typeof streamThreadResponseSchema>;

import {
  chunkEmbeddings,
  chunks,
  documents,
  sources,
  sourceRevisions,
} from "../../../shared/db/schema";
import type {
  ChunkRecord,
  ParsingConfig,
  SourceDocumentRecord,
  SourceEmbeddingRecord,
  SourceMetadata,
  SourceRecord,
  SourceRevisionRecord,
} from "../types";

type SourceRow = typeof sources.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type ChunkEmbeddingRow = typeof chunkEmbeddings.$inferSelect;
type SourceRevisionRow = typeof sourceRevisions.$inferSelect;

export function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    ingestKind: row.ingestKind,
    sourceType: row.sourceType as SourceRecord["sourceType"],
    parentSourceId: row.parentSourceId,
    title: row.title,
    contentText: row.contentText,
    externalId: row.externalId,
    externalUri: row.externalUri,
    externalUpdatedAt: row.externalUpdatedAt
      ? row.externalUpdatedAt.toISOString()
      : null,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    status: row.status,
    estimatedPages: row.estimatedPages,
    parsedTokens: row.parsedTokens,
    parserVersion: row.parserVersion,
    parsingConfig: (row.parsingConfig ?? null) as ParsingConfig | null,
    metadata: (row.metadataJson ?? {}) as SourceMetadata,
    error: row.errorJson ?? {},
    createdBy: row.createdBy,
    indexedAt: row.indexedAt ? row.indexedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapSourceRevision(row: SourceRevisionRow): SourceRevisionRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    revisionNo: row.revisionNo,
    contentHash: row.contentHash,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    parserVersion: row.parserVersion,
    isLatest: row.isLatest,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapChunk(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    documentId: row.documentId,
    chunkNo: row.chunkNo,
    content: row.content,
    headingPath: row.headingPath,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    language: row.language,
    chunkMetadata: row.chunkMetadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapSourceDocument(row: DocumentRow): SourceDocumentRecord {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    contentText: row.contentText,
    status: row.status,
    tokenCount: row.tokenCount,
    charCount: row.charCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapSourceEmbedding(row: ChunkEmbeddingRow): SourceEmbeddingRecord {
  return {
    id: row.id,
    chunkId: row.chunkId,
    embeddingProfileId: row.embeddingProfileId,
    modelAlias: row.modelAlias,
    dim: row.dim,
    createdAt: row.createdAt.toISOString(),
  };
}

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  chunkEmbeddings,
  chunks,
  db,
  documents,
  modelGatewayProfiles,
  retrievalHits,
  retrievalRuns,
  sources,
} from "@sourceweft/db";
import type {
  ChunkRecord,
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
} from "../content/types";
import { logBm25Completed, logBm25Failed, logBm25Skipped } from "./bm25-debug";
import { toPostgresTextArray } from "./sql";
import { buildSearchQuery } from "./search-tokenizer";
import {
  currentDocumentCondition,
  currentDocumentConditionForAlias,
} from "./current-document-condition";

const CHUNKS_BM25_INDEX_NAME = "chunks_bm25_universal_idx";

type EmbeddingProfileRow = typeof modelGatewayProfiles.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;

type RetrievalSqlRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  source_title: string;
  chunk_no: number;
  content: string;
  score: number;
};

type RetrievalDocumentChunkSqlRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  source_title: string;
  chunk_no: number;
  content: string;
};

type RetrievalDocumentChunkStatsSqlRow = {
  document_id: string;
  source_id: string;
  chunk_count: number | string;
  total_chars: number | string | null;
};

export type RetrievalDocumentChunk = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceTitle: string;
  chunkNo: number;
  content: string;
};

export type RetrievalDocumentChunkStats = {
  documentId: string;
  sourceId: string;
  chunkCount: number;
  totalChars: number;
};

function mapEmbeddingProfile(row: EmbeddingProfileRow): EmbeddingProfileRecord {
  return {
    id: row.id,
    profileAlias: row.profileAlias,
    kind: "embedding",
    gatewayConfigId: row.gatewayConfigId,
    modelAlias: row.modelAlias,
    requestedDimensions: row.requestedDimensions,
    vectorStrategy: row.vectorStrategy,
    isDefault: row.isDefault,
    isActive: row.isActive,
    configJson: row.configJson ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapChunk(row: ChunkRow): ChunkRecord {
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

function mapDocumentChunk(
  row: RetrievalDocumentChunkSqlRow,
): RetrievalDocumentChunk {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    chunkNo: Number(row.chunk_no),
    content: row.content,
  };
}

function documentPairKey(input: { documentId: string; sourceId: string }) {
  return `${input.sourceId}:${input.documentId}`;
}

export async function findDefaultEmbeddingProfile() {
  const [row] = await db
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, "embedding"),
        eq(modelGatewayProfiles.isDefault, true),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return row ? mapEmbeddingProfile(row) : null;
}

export async function listSourceChunksByProfile(input: {
  teamId: string;
  workspaceId: string;
  embeddingProfileId: string;
  sourceIds?: string[];
}) {
  const conditions = [
    eq(chunks.teamId, input.teamId),
    eq(chunks.workspaceId, input.workspaceId),
    eq(chunkEmbeddings.embeddingProfileId, input.embeddingProfileId),
    eq(sources.status, "indexed"),
    currentDocumentCondition(),
  ];

  if (input.sourceIds && input.sourceIds.length > 0) {
    conditions.push(
      sql`${chunks.sourceId} = ANY(${toPostgresTextArray(input.sourceIds)}::text[])` as never,
    );
  }

  const rows = await db
    .select({
      chunk: chunks,
      embeddingId: chunkEmbeddings.id,
      embedding: chunkEmbeddings.embedding,
      dim: chunkEmbeddings.dim,
      modelAlias: chunkEmbeddings.modelAlias,
    })
    .from(chunkEmbeddings)
    .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .innerJoin(sources, eq(sources.id, chunks.sourceId))
    .where(and(...conditions))
    .orderBy(asc(chunks.createdAt), asc(chunks.chunkNo));

  return rows.map((row) => ({
    chunk: mapChunk(row.chunk),
    embedding: row.embedding,
    dim: row.dim,
    modelAlias: row.modelAlias,
    embeddingId: row.embeddingId,
  }));
}

export async function searchChunksByBm25(input: {
  teamId: string;
  workspaceId: string;
  queryText: string;
  topK: number;
  sourceIds: string[];
}) {
  if (input.sourceIds.length === 0) {
    logBm25Skipped({
      operation: "retrieval",
      reason: "empty_source_ids",
      queryText: input.queryText,
      topK: input.topK,
      sourceCount: 0,
    });
    return [];
  }

  const searchQuery = buildSearchQuery(input.queryText);
  if (!searchQuery) {
    logBm25Skipped({
      operation: "retrieval",
      reason: "empty_search_query",
      queryText: input.queryText,
      searchQuery,
      topK: input.topK,
      sourceCount: input.sourceIds.length,
    });
    return [];
  }

  const bm25Query = sql`to_bm25query(${searchQuery}, ${CHUNKS_BM25_INDEX_NAME})`;
  const bm25Score = sql`c.search_parts <@> ${bm25Query}`;

  const startedAt = Date.now();
  try {
    const rows = await db.execute<RetrievalSqlRow>(sql`
      select
        c.id as chunk_id,
        c.document_id,
        c.source_id,
        s.title as source_title,
        c.chunk_no,
        c.content,
        -(${bm25Score}) as score
      from chunks c
      inner join sources s on s.id = c.source_id
      inner join documents d on d.id = c.document_id
      where c.workspace_id = ${input.workspaceId}
        and c.team_id = ${input.teamId}
        and s.status = 'indexed'
        and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
        and ${currentDocumentConditionForAlias("d")}
      order by ${bm25Score} asc
      limit ${input.topK}
    `);

    const candidates = rows.rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      chunkNo: Number(row.chunk_no),
      content: row.content,
      score: Number(row.score),
      stage: "bm25" as const,
    }));

    logBm25Completed({
      operation: "retrieval",
      queryText: input.queryText,
      searchQuery,
      topK: input.topK,
      sourceCount: input.sourceIds.length,
      durationMs: Date.now() - startedAt,
      results: candidates,
    });

    return candidates;
  } catch (error) {
    logBm25Failed({
      operation: "retrieval",
      queryText: input.queryText,
      searchQuery,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function searchChunksByVectorExact(input: {
  teamId: string;
  workspaceId: string;
  embeddingProfileId: string;
  queryEmbedding: number[];
  topK: number;
  sourceIds: string[];
}) {
  if (input.sourceIds.length === 0) {
    return [];
  }

  const rows = await db.execute<RetrievalSqlRow>(sql`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      s.title as source_title,
      c.chunk_no,
      c.content,
      1 - (ce.embedding <=> ${`[${input.queryEmbedding.join(",")}]`}::vector) as score
    from chunk_embeddings ce
    inner join chunks c on c.id = ce.chunk_id
    inner join documents d on d.id = c.document_id
    inner join sources s on s.id = c.source_id
    where ce.team_id = ${input.teamId}
      and ce.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      and ce.embedding_profile_id = ${input.embeddingProfileId}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
      and ${currentDocumentConditionForAlias("d")}
    order by ce.embedding <=> ${`[${input.queryEmbedding.join(",")}]`}::vector asc
    limit ${input.topK}
  `);

  return rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    score: Number(row.score),
    stage: "vector" as const,
  }));
}

export async function searchChunksByVectorAnn(input: {
  teamId: string;
  workspaceId: string;
  embeddingProfileId: string;
  queryEmbedding: number[];
  dim: number;
  topK: number;
  sourceIds: string[];
}) {
  if (!Number.isInteger(input.dim) || input.dim <= 0 || input.dim > 2000) {
    throw new Error("Invalid vector dimensions for ANN search");
  }

  if (input.sourceIds.length === 0) {
    return [];
  }

  const dimLiteral = sql.raw(String(input.dim));
  const queryVector = `[${input.queryEmbedding.join(",")}]`;
  const rows = await db.execute<RetrievalSqlRow>(sql`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      s.title as source_title,
      c.chunk_no,
      c.content,
      1 - (ce.embedding::vector(${dimLiteral}) <=> ${queryVector}::vector(${dimLiteral})) as score
    from chunk_embeddings ce
    inner join chunks c on c.id = ce.chunk_id
    inner join documents d on d.id = c.document_id
    inner join sources s on s.id = c.source_id
    where ce.team_id = ${input.teamId}
      and ce.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      and ce.embedding_profile_id = ${input.embeddingProfileId}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
      and ce.dim = ${input.dim}
      and ${currentDocumentConditionForAlias("d")}
    order by ce.embedding::vector(${dimLiteral}) <=> ${queryVector}::vector(${dimLiteral}) asc
    limit ${input.topK}
  `);

  return rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    score: Number(row.score),
    stage: "vector" as const,
  }));
}

export async function listDocumentChunkStats(input: {
  teamId: string;
  workspaceId: string;
  documents: Array<{
    documentId: string;
    sourceId: string;
  }>;
}) {
  if (input.documents.length === 0) {
    return [];
  }

  const documentIds = [
    ...new Set(input.documents.map((doc) => doc.documentId)),
  ];
  const sourceIds = [...new Set(input.documents.map((doc) => doc.sourceId))];
  const requestedPairs = new Set(input.documents.map(documentPairKey));

  const rows = await db.execute<RetrievalDocumentChunkStatsSqlRow>(sql`
    select
      c.document_id,
      c.source_id,
      count(c.id)::int as chunk_count,
      coalesce(sum(char_length(c.content)), 0)::int as total_chars
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.workspace_id = ${input.workspaceId}
      and c.team_id = ${input.teamId}
      and s.status = 'indexed'
      and c.document_id = any(${toPostgresTextArray(documentIds)}::text[])
      and c.source_id = any(${toPostgresTextArray(sourceIds)}::text[])
      and ${currentDocumentConditionForAlias("d")}
    group by c.document_id, c.source_id
  `);

  return rows.rows
    .filter((row) =>
      requestedPairs.has(
        documentPairKey({
          documentId: row.document_id,
          sourceId: row.source_id,
        }),
      ),
    )
    .map((row) => ({
      documentId: row.document_id,
      sourceId: row.source_id,
      chunkCount: Number(row.chunk_count),
      totalChars: Number(row.total_chars ?? 0),
    }));
}

export async function listDocumentChunksInRange(input: {
  teamId: string;
  workspaceId: string;
  documentId: string;
  sourceId: string;
  startChunkNo: number;
  endChunkNo: number;
}) {
  const rows = await db.execute<RetrievalDocumentChunkSqlRow>(sql`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      s.title as source_title,
      c.chunk_no,
      c.content
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.workspace_id = ${input.workspaceId}
      and c.team_id = ${input.teamId}
      and s.status = 'indexed'
      and c.document_id = ${input.documentId}
      and c.source_id = ${input.sourceId}
      and c.chunk_no >= ${input.startChunkNo}
      and c.chunk_no <= ${input.endChunkNo}
      and ${currentDocumentConditionForAlias("d")}
    order by c.chunk_no asc
  `);

  return rows.rows.map(mapDocumentChunk);
}

export async function listDocumentChunksForDocument(input: {
  teamId: string;
  workspaceId: string;
  documentId: string;
  sourceId: string;
  limit: number;
}) {
  const rows = await db.execute<RetrievalDocumentChunkSqlRow>(sql`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      s.title as source_title,
      c.chunk_no,
      c.content
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.workspace_id = ${input.workspaceId}
      and c.team_id = ${input.teamId}
      and s.status = 'indexed'
      and c.document_id = ${input.documentId}
      and c.source_id = ${input.sourceId}
      and ${currentDocumentConditionForAlias("d")}
    order by c.chunk_no asc
    limit ${input.limit}
  `);

  return rows.rows.map(mapDocumentChunk);
}

export async function createRetrievalRun(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  embeddingProfileId: string | null;
  queryText: string;
  embedModelAlias: string | null;
  rerankModelAlias: string | null;
  vectorStrategyUsed: EmbeddingVectorStrategy;
  annIndexUsed?: string | null;
  bm25TopK?: number | null;
  vectorTopK?: number | null;
  rrfK?: number | null;
  prefilterCount?: number | null;
  candidateCount?: number | null;
  finalResultCount?: number | null;
  latencyMs?: number | null;
  metadataJson?: Record<string, unknown>;
}) {
  const id = randomUUID();
  await db.insert(retrievalRuns).values({
    id,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    messageId: input.messageId,
    embeddingProfileId: input.embeddingProfileId,
    queryText: input.queryText,
    embedModelAlias: input.embedModelAlias,
    rerankModelAlias: input.rerankModelAlias,
    vectorStrategyUsed: input.vectorStrategyUsed,
    annIndexUsed: input.annIndexUsed ?? null,
    bm25TopK: input.bm25TopK ?? null,
    vectorTopK: input.vectorTopK ?? null,
    rrfK: input.rrfK ?? null,
    prefilterCount: input.prefilterCount ?? null,
    candidateCount: input.candidateCount ?? null,
    finalResultCount: input.finalResultCount ?? null,
    latencyMs: input.latencyMs ?? null,
    metadataJson: input.metadataJson ?? {},
  });

  return id;
}

export async function createRetrievalHits(input: {
  runId: string;
  hits: Array<{
    sourceStage: "bm25" | "vector" | "rrf" | "rerank";
    hitType: "chunk" | "document";
    sourceId?: string | null;
    documentId?: string | null;
    chunkId?: string | null;
    rank: number;
    score: number;
  }>;
}) {
  if (input.hits.length === 0) {
    return;
  }

  await db.insert(retrievalHits).values(
    input.hits.map((hit) => ({
      id: randomUUID(),
      runId: input.runId,
      sourceStage: hit.sourceStage,
      hitType: hit.hitType,
      sourceId: hit.sourceId ?? null,
      documentId: hit.documentId ?? null,
      chunkId: hit.chunkId ?? null,
      rank: hit.rank,
      score: hit.score,
      createdAt: new Date(),
    })),
  );
}

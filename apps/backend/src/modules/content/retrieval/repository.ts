import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import {
  chunkEmbeddings,
  chunks,
  documents,
  modelGatewayProfiles,
  retrievalHits,
  retrievalRuns,
  sources,
} from "../../../shared/db/schema";
import type {
  ChunkRecord,
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
} from "../types";
import { toPostgresTextArray } from "../sql";
import {
  currentDocumentCondition,
  currentDocumentConditionForAlias,
} from "../sources/current-document-condition";

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
      pdb.score(c.id) as score
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.workspace_id = ${input.workspaceId}
      and c.team_id = ${input.teamId}
      and s.status = 'indexed'
      and c.content ||| ${input.queryText}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
      and ${currentDocumentConditionForAlias("d")}
    order by pdb.score(c.id) desc
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
    stage: "bm25" as const,
  }));
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
  if (input.sourceIds.length === 0) {
    return [];
  }

  if (!Number.isInteger(input.dim) || input.dim <= 0 || input.dim > 2000) {
    throw new Error("Invalid vector dimensions for ANN search");
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

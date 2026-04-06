import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../shared/database";
import {
  chunkEmbeddings,
  chunks,
  citations,
  documents,
  embeddingProfiles,
  messages,
  retrievalHits,
  retrievalRuns,
  sources,
  threadSources,
  threads,
} from "../../shared/db/schema";
import type {
  ChunkRecord,
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
  MessageRecord,
  MessageRole,
  SourceDetailRecord,
  SourceDocumentRecord,
  SourceEmbeddingRecord,
  SourceRecord,
  SourceStatus,
  ThreadRecord,
} from "./types";

type SourceRow = typeof sources.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type EmbeddingProfileRow = typeof embeddingProfiles.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type ChunkEmbeddingRow = typeof chunkEmbeddings.$inferSelect;
type ThreadSourceRow = typeof threadSources.$inferSelect;

type RetrievalSqlRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  content: string;
  score: number;
};

type ThreadSourceRecord = {
  threadId: string;
  sourceId: string;
  selectedBy: string | null;
  createdAt: string;
};

function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    contentText: row.contentText,
    status: row.status,
    estimatedPages: row.estimatedPages,
    parsedTokens: row.parsedTokens,
    createdBy: row.createdBy,
    indexedAt: row.indexedAt ? row.indexedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    createdBy: row.createdBy,
    model: row.model,
    creditsConsumed: row.creditsConsumed,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function mapEmbeddingProfile(row: EmbeddingProfileRow): EmbeddingProfileRecord {
  return {
    id: row.id,
    alias: row.alias,
    providerKind: row.providerKind,
    providerModelAlias: row.providerModelAlias,
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

function mapSourceDocument(row: DocumentRow): SourceDocumentRecord {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    status: row.status,
    tokenCount: row.tokenCount,
    charCount: row.charCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSourceEmbedding(row: ChunkEmbeddingRow): SourceEmbeddingRecord {
  return {
    id: row.id,
    chunkId: row.chunkId,
    embeddingProfileId: row.embeddingProfileId,
    modelAlias: row.modelAlias,
    dim: row.dim,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapThreadSource(row: ThreadSourceRow): ThreadSourceRecord {
  return {
    threadId: row.threadId,
    sourceId: row.sourceId,
    selectedBy: row.selectedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  contentText: string;
  createdBy: string;
  estimatedPages?: number;
  parsedTokens?: number;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(sources)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      contentText: input.contentText,
      status: "created",
      estimatedPages: input.estimatedPages ?? null,
      parsedTokens: input.parsedTokens ?? null,
      createdBy: input.createdBy,
      indexedAt: null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create source");
  }

  return mapSource(row);
}

export async function listSourceRecords(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(sources.updatedAt), desc(sources.createdAt));

  return rows.map(mapSource);
}

export async function findSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapSource(row) : null;
}

export async function updateSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  title?: string;
  contentText?: string;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
}) {
  const updates: Partial<typeof sources.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (input.title !== undefined) {
    updates.title = input.title;
  }

  if (input.contentText !== undefined) {
    updates.contentText = input.contentText;
    updates.status = "created";
    updates.indexedAt = null;
  }

  if (input.estimatedPages !== undefined) {
    updates.estimatedPages = input.estimatedPages;
  }

  if (input.parsedTokens !== undefined) {
    updates.parsedTokens = input.parsedTokens;
  }

  const [row] = await db
    .update(sources)
    .set(updates)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapSource(row) : null;
}

export async function deleteSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const rows = await db
    .delete(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: sources.id });

  return rows.length > 0;
}

export async function getSourceDetailRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}): Promise<SourceDetailRecord | null> {
  const source = await findSourceRecord(input);
  if (!source) {
    return null;
  }

  const [documentRows, chunkRows, embeddingRows] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.sourceId, input.sourceId),
          eq(documents.teamId, input.teamId),
          eq(documents.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(documents.createdAt)),
    db
      .select()
      .from(chunks)
      .where(
        and(
          eq(chunks.sourceId, input.sourceId),
          eq(chunks.teamId, input.teamId),
          eq(chunks.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(chunks.chunkNo)),
    db
      .select({
        embedding: chunkEmbeddings,
      })
      .from(chunkEmbeddings)
      .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
      .where(
        and(
          eq(chunks.sourceId, input.sourceId),
          eq(chunkEmbeddings.teamId, input.teamId),
          eq(chunkEmbeddings.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(chunkEmbeddings.createdAt)),
  ]);

  return {
    source,
    documents: documentRows.map(mapSourceDocument),
    chunks: chunkRows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      chunkNo: row.chunkNo,
      content: row.content,
      headingPath: row.headingPath,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
      language: row.language,
      createdAt: row.createdAt.toISOString(),
    })),
    embeddings: embeddingRows.map((row) => mapSourceEmbedding(row.embedding)),
  };
}

export async function updateSourceStatus(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  status: SourceStatus;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  indexedAt?: Date | null;
}) {
  const updates: {
    status: SourceStatus;
    indexedAt?: Date | null;
    updatedAt: Date;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  } = {
    status: input.status,
    updatedAt: new Date(),
  };

  if (input.indexedAt !== undefined) {
    updates.indexedAt = input.indexedAt;
  }

  if (input.estimatedPages !== undefined) {
    updates.estimatedPages = input.estimatedPages;
  }

  if (input.parsedTokens !== undefined) {
    updates.parsedTokens = input.parsedTokens;
  }

  const [row] = await db
    .update(sources)
    .set(updates)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  if (!row) {
    throw new Error("Failed to update source status");
  }

  return mapSource(row);
}

export async function createThreadRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(threads)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapThread(row);
}

export async function findThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapThread(row) : null;
}

export async function createMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdBy?: string | null;
  model?: string | null;
  creditsConsumed?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(messages)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      createdBy: input.createdBy ?? null,
      model: input.model ?? null,
      creditsConsumed: input.creditsConsumed ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create message");
  }

  return mapMessage(row);
}

export async function findDefaultEmbeddingProfile() {
  const [row] = await db
    .select()
    .from(embeddingProfiles)
    .where(
      and(
        eq(embeddingProfiles.isDefault, true),
        eq(embeddingProfiles.isActive, true),
      ),
    )
    .limit(1);

  return row ? mapEmbeddingProfile(row) : null;
}

export async function replaceSourceDocumentsAndEmbeddings(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  sourceTitle: string;
  sourceContentText: string;
  embeddingProfileId: string;
  modelAlias: string;
  embeddings: number[][];
  requestedDimensions: number | null;
}) {
  const normalizedText = input.sourceContentText.trim();
  const baseTitle = input.sourceTitle.trim() || "Untitled Source";
  const chunkSize = 1200;
  const overlap = 200;
  const segments: Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    chunkNo: number;
  }> = [];

  if (normalizedText.length > 0) {
    let start = 0;
    let chunkNo = 0;
    while (start < normalizedText.length) {
      const end = Math.min(start + chunkSize, normalizedText.length);
      const content = normalizedText.slice(start, end).trim();
      if (content.length > 0) {
        segments.push({
          content,
          startOffset: start,
          endOffset: end,
          chunkNo,
        });
        chunkNo += 1;
      }
      if (end >= normalizedText.length) {
        break;
      }
      start = Math.max(0, end - overlap);
    }
  }

  const now = new Date();

  return db.transaction(async (tx) => {
    await tx.delete(documents).where(eq(documents.sourceId, input.sourceId));

    const documentId = randomUUID();
    await tx.insert(documents).values({
      id: documentId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      title: baseTitle,
      language: null,
      contentText: normalizedText,
      tokenCount: Math.max(0, Math.ceil(normalizedText.length / 4)),
      charCount: normalizedText.length,
      status: "ready",
      documentMetadata: {
        requestedDimensions: input.requestedDimensions,
        chunkCount: segments.length,
      },
      createdAt: now,
      updatedAt: now,
    });

    const chunkIds: string[] = [];
    if (segments.length > 0) {
      const chunkRows = segments.map((segment) => {
        const chunkId = randomUUID();
        chunkIds.push(chunkId);
        return {
          id: chunkId,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          documentId,
          chunkNo: segment.chunkNo,
          content: segment.content,
          headingPath: null,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          language: null,
          chunkMetadata: {},
          createdAt: now,
        };
      });

      await tx.insert(chunks).values(chunkRows);

      if (input.embeddings.length !== chunkRows.length) {
        throw new Error("Embedding count does not match chunk count");
      }

      await tx.insert(chunkEmbeddings).values(
        chunkRows.map((chunkRow, index) => ({
          id: randomUUID(),
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          chunkId: chunkRow.id,
          embeddingProfileId: input.embeddingProfileId,
          modelAlias: input.modelAlias,
          dim: input.embeddings[index]?.length ?? 0,
          embedding: input.embeddings[index] ?? [],
          createdAt: now,
        })),
      );
    }

    return {
      documentId,
      chunkIds,
      chunkCount: segments.length,
    };
  });
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
  ];

  if (input.sourceIds && input.sourceIds.length > 0) {
    conditions.push(sql`${chunks.sourceId} = ANY(${input.sourceIds})` as never);
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

export async function listThreadSourceIds(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const rows = await db
    .select()
    .from(threadSources)
    .where(
      and(
        eq(threadSources.teamId, input.teamId),
        eq(threadSources.workspaceId, input.workspaceId),
        eq(threadSources.threadId, input.threadId),
      ),
    )
    .orderBy(asc(threadSources.createdAt));

  return rows.map((row) => row.sourceId);
}

export async function listThreadSourceRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const rows = await db
    .select()
    .from(threadSources)
    .where(
      and(
        eq(threadSources.teamId, input.teamId),
        eq(threadSources.workspaceId, input.workspaceId),
        eq(threadSources.threadId, input.threadId),
      ),
    )
    .orderBy(asc(threadSources.createdAt));

  return rows.map(mapThreadSource);
}

export async function replaceThreadSourceRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  selectedBy: string;
  sourceIds: string[];
}) {
  return db.transaction(async (tx) => {
    await tx
      .delete(threadSources)
      .where(
        and(
          eq(threadSources.teamId, input.teamId),
          eq(threadSources.workspaceId, input.workspaceId),
          eq(threadSources.threadId, input.threadId),
        ),
      );

    if (input.sourceIds.length === 0) {
      return [] as ThreadSourceRecord[];
    }

    const inserted = await tx
      .insert(threadSources)
      .values(
        input.sourceIds.map((sourceId) => ({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          sourceId,
          selectedBy: input.selectedBy,
          createdAt: new Date(),
        })),
      )
      .returning();

    return inserted.map(mapThreadSource);
  });
}

export async function searchChunksByBm25(input: {
  teamId: string;
  workspaceId: string;
  queryText: string;
  topK: number;
  sourceIds?: string[];
}) {
  const rows = await db.execute<RetrievalSqlRow>(sql`
    select
      id as chunk_id,
      document_id,
      source_id,
      content,
      pdb.score(id) as score
    from chunks
    where workspace_id = ${input.workspaceId}
      and team_id = ${input.teamId}
      and content ||| ${input.queryText}
      ${
        input.sourceIds && input.sourceIds.length > 0
          ? sql`and source_id = any(${input.sourceIds})`
          : sql``
      }
    order by pdb.score(id) desc
    limit ${input.topK}
  `);

  return rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
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
  sourceIds?: string[];
}) {
  const rows = await db.execute<RetrievalSqlRow>(sql`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      c.content,
      1 - (ce.embedding <=> ${`[${input.queryEmbedding.join(",")}]`}::vector) as score
    from chunk_embeddings ce
    inner join chunks c on c.id = ce.chunk_id
    where ce.team_id = ${input.teamId}
      and ce.workspace_id = ${input.workspaceId}
      and ce.embedding_profile_id = ${input.embeddingProfileId}
      ${
        input.sourceIds && input.sourceIds.length > 0
          ? sql`and c.source_id = any(${input.sourceIds})`
          : sql``
      }
    order by ce.embedding <=> ${`[${input.queryEmbedding.join(",")}]`}::vector asc
    limit ${input.topK}
  `);

  return rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
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
  sourceIds?: string[];
}) {
  const queryVector = `[${input.queryEmbedding.join(",")}]`;
  const sourceFilter =
    input.sourceIds && input.sourceIds.length > 0
      ? `and c.source_id = any(array[${input.sourceIds.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")}])`
      : "";
  const rows = await db.execute<RetrievalSqlRow>(
    sql.raw(`
    select
      c.id as chunk_id,
      c.document_id,
      c.source_id,
      c.content,
      1 - (ce.embedding::vector(${input.dim}) <=> '${queryVector}'::vector(${input.dim})) as score
    from chunk_embeddings ce
    inner join chunks c on c.id = ce.chunk_id
    where ce.team_id = '${input.teamId.replace(/'/g, "''")}'
      and ce.workspace_id = '${input.workspaceId.replace(/'/g, "''")}'
      and ce.embedding_profile_id = '${input.embeddingProfileId.replace(/'/g, "''")}'
      ${sourceFilter}
      and ce.dim = ${input.dim}
    order by ce.embedding::vector(${input.dim}) <=> '${queryVector}'::vector(${input.dim}) asc
    limit ${input.topK}
  `),
  );

  return rows.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    content: row.content,
    score: Number(row.score),
    stage: "vector" as const,
  }));
}

export async function createCitationRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  citations: Array<{
    sourceId: string;
    documentId: string;
    chunkId: string;
    quoteText: string;
    rank: number;
    score: number;
  }>;
}) {
  if (input.citations.length === 0) {
    return;
  }

  await db.insert(citations).values(
    input.citations.map((citation) => ({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      sourceId: citation.sourceId,
      documentId: citation.documentId,
      chunkId: citation.chunkId,
      citationKey: `${input.messageId}:${citation.rank}`,
      quoteText: citation.quoteText,
      rank: citation.rank,
      score: citation.score,
      metadataJson: {},
      createdAt: new Date(),
    })),
  );
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

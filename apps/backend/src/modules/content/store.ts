import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../../shared/database";
import {
  chunkEmbeddings,
  chunks,
  citations,
  documents,
  messages,
  modelGatewayByokKeyRefs,
  modelGatewayProfiles,
  retrievalHits,
  retrievalRuns,
  sources,
  sourceRevisions,
  threads,
} from "../../shared/db/schema";
import type {
  ChunkRecord,
  ChunkSpec,
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
  ByokKeyRefRecord,
  MessageRecord,
  MessageRole,
  SourceDetailRecord,
  SourceDocumentRecord,
  SourceEmbeddingRecord,
  SourceMetadata,
  SourceRecord,
  SourceRevisionRecord,
  SourceStatus,
  SourceStatusDetail,
  SourceStatusStep,
  ThreadRecord,
  ParsingConfig,
} from "./types";

type SourceRow = typeof sources.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type EmbeddingProfileRow = typeof modelGatewayProfiles.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type ChunkEmbeddingRow = typeof chunkEmbeddings.$inferSelect;
type ByokKeyRefRow = typeof modelGatewayByokKeyRefs.$inferSelect;
type SourceRevisionRow = typeof sourceRevisions.$inferSelect;

function normalizeThreadModelSettings(value: unknown) {
  const record = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  const asNullableAlias = (candidate: unknown) =>
    typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim()
      : null;

  return {
    llmProfileAlias: asNullableAlias(record.llmProfileAlias),
    imageProfileAlias: asNullableAlias(record.imageProfileAlias),
    visionProfileAlias: asNullableAlias(record.visionProfileAlias),
  };
}

type RetrievalSqlRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  source_title: string;
  chunk_no: number;
  content: string;
  score: number;
};

function toPostgresTextArray(values: string[]) {
  return `{${values
    .map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
}

function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    ingestKind: row.ingestKind,
    sourceType: row.sourceType as SourceRecord["sourceType"],
    title: row.title,
    contentText: row.contentText,
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

function mapSourceRevision(row: SourceRevisionRow): SourceRevisionRecord {
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

function mapThread(row: ThreadRow, sourceCount = 0): ThreadRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    modelSettings: normalizeThreadModelSettings(row.modelSettingsJson),
    sourceCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function countUsedSourceIdsByThread(input: {
  teamId: string;
  workspaceId: string;
  threadIds: string[];
}) {
  if (input.threadIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await db.execute<{ thread_id: string; source_count: number | string }>(sql`
    select
      m.thread_id,
      count(distinct source_id.value)::int as source_count
    from messages m
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(m.metadata->'sourceIds') = 'array'
        then m.metadata->'sourceIds'
        else '[]'::jsonb
      end
    ) as source_id(value)
    where m.team_id = ${input.teamId}
      and m.workspace_id = ${input.workspaceId}
      and m.role = 'user'
      and m.thread_id = any(${toPostgresTextArray(input.threadIds)}::text[])
    group by m.thread_id
  `);

  return new Map(
    rows.rows.map((row) => [row.thread_id, Number(row.source_count)]),
  );
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    parentMessageId: row.parentMessageId,
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

function mapByokKeyRef(row: ByokKeyRefRow): ByokKeyRefRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    providerName: row.providerName,
    keyRef: row.keyRef,
    isActive: row.isActive,
    metadata: row.metadataJson ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  sourceType?: SourceRecord["sourceType"];
  mimeType?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  parserVersion?: string | null;
  parsingConfig?: ParsingConfig | null;
  metadata?: SourceMetadata;
  error?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(sources)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      ingestKind: "manual_upload",
      sourceType: input.sourceType ?? "manual_upload",
      title: input.title,
      contentText: input.contentText,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      contentHash: input.contentHash ?? null,
      storageBucket: input.storageBucket ?? null,
      storageKey: input.storageKey ?? null,
      parserVersion: input.parserVersion ?? null,
      parsingConfig: input.parsingConfig ?? {},
      status: "created",
      estimatedPages: input.estimatedPages ?? null,
      parsedTokens: input.parsedTokens ?? null,
      errorJson: input.error ?? {},
      metadataJson: input.metadata ?? {},
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
  mimeType?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  parserVersion?: string | null;
  parsingConfig?: ParsingConfig | null;
  metadata?: SourceMetadata;
  error?: Record<string, unknown>;
  status?: SourceStatus;
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

  if (input.mimeType !== undefined) {
    updates.mimeType = input.mimeType;
  }

  if (input.sizeBytes !== undefined) {
    updates.sizeBytes = input.sizeBytes;
  }

  if (input.contentHash !== undefined) {
    updates.contentHash = input.contentHash;
  }

  if (input.storageBucket !== undefined) {
    updates.storageBucket = input.storageBucket;
  }

  if (input.storageKey !== undefined) {
    updates.storageKey = input.storageKey;
  }

  if (input.parserVersion !== undefined) {
    updates.parserVersion = input.parserVersion;
  }

  if (input.parsingConfig !== undefined) {
    updates.parsingConfig = input.parsingConfig ?? {};
  }

  if (input.metadata !== undefined) {
    updates.metadataJson = input.metadata;
  }

  if (input.error !== undefined) {
    updates.errorJson = input.error;
  }

  if (input.status !== undefined) {
    updates.status = input.status;
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

  const [documentRows, chunkRows, embeddingRows, revisionRows] = await Promise.all([
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
    db
      .select()
      .from(sourceRevisions)
      .where(
        and(
          eq(sourceRevisions.sourceId, input.sourceId),
          eq(sourceRevisions.teamId, input.teamId),
          eq(sourceRevisions.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(desc(sourceRevisions.revisionNo), desc(sourceRevisions.createdAt)),
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
    revisions: revisionRows.map(mapSourceRevision),
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
  error?: Record<string, unknown>;
  metadata?: SourceMetadata;
}) {
  const updates: {
    status: SourceStatus;
    indexedAt?: Date | null;
    updatedAt: Date;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
    errorJson?: Record<string, unknown>;
    metadataJson?: SourceMetadata;
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

  if (input.error !== undefined) {
    updates.errorJson = input.error;
  }

  if (input.metadata !== undefined) {
    updates.metadataJson = input.metadata;
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

export async function listSourceRevisionRecords(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const rows = await db
    .select()
    .from(sourceRevisions)
    .where(
      and(
        eq(sourceRevisions.teamId, input.teamId),
        eq(sourceRevisions.workspaceId, input.workspaceId),
        eq(sourceRevisions.sourceId, input.sourceId),
      ),
    )
    .orderBy(desc(sourceRevisions.revisionNo), desc(sourceRevisions.createdAt));

  return rows.map(mapSourceRevision);
}

export async function listSourceChunks(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const rows = await db
    .select()
    .from(chunks)
    .where(
      and(
        eq(chunks.teamId, input.teamId),
        eq(chunks.workspaceId, input.workspaceId),
        eq(chunks.sourceId, input.sourceId),
      ),
    )
    .orderBy(asc(chunks.chunkNo));

  return rows.map(mapChunk);
}

export async function createSourceRevisionRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  contentHash?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  parserVersion?: string | null;
  externalUpdatedAt?: Date | null;
}) {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ revisionNo: sourceRevisions.revisionNo })
      .from(sourceRevisions)
      .where(
        and(
          eq(sourceRevisions.teamId, input.teamId),
          eq(sourceRevisions.workspaceId, input.workspaceId),
          eq(sourceRevisions.sourceId, input.sourceId),
          eq(sourceRevisions.isLatest, true),
        ),
      )
      .limit(1);

    await tx
      .update(sourceRevisions)
      .set({ isLatest: false })
      .where(
        and(
          eq(sourceRevisions.teamId, input.teamId),
          eq(sourceRevisions.workspaceId, input.workspaceId),
          eq(sourceRevisions.sourceId, input.sourceId),
          eq(sourceRevisions.isLatest, true),
        ),
      );

    const [row] = await tx
      .insert(sourceRevisions)
      .values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        revisionNo: (latest?.revisionNo ?? 0) + 1,
        contentHash: input.contentHash ?? null,
        storageBucket: input.storageBucket ?? null,
        storageKey: input.storageKey ?? null,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        parserVersion: input.parserVersion ?? null,
        isLatest: true,
        createdAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create source revision");
    }

    return mapSourceRevision(row);
  });
}

function deriveStatusDetail(source: SourceRecord): SourceStatusDetail {
  const metadata = source.metadata ?? {};
  const status = source.status;
  const progress =
    typeof metadata.progress === "number" && Number.isFinite(metadata.progress)
      ? Math.max(0, Math.min(100, metadata.progress))
      : status === "indexed"
        ? 100
        : status === "failed"
          ? 100
          : status === "processing"
            ? 50
            : status === "queued"
              ? 10
              : 0;

  const currentStep =
    typeof metadata.currentStep === "string"
      ? (metadata.currentStep as SourceStatusStep)
      : status === "indexed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "processing"
            ? "parsing"
            : status === "queued"
              ? "queued"
              : "created";

  const parsedPages =
    typeof metadata.parsedPages === "number" ? metadata.parsedPages : null;
  const totalPages =
    typeof metadata.totalPages === "number"
      ? metadata.totalPages
      : source.estimatedPages;
  const error =
    typeof source.error?.message === "string"
      ? source.error.message
      : typeof metadata.error === "string"
        ? metadata.error
        : null;
  const jobId = typeof metadata.jobId === "string" ? metadata.jobId : null;

  return {
    status,
    progress,
    currentStep,
    parsedPages,
    totalPages,
    error,
    jobId,
  };
}

export async function getSourceStatusDetail(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const source = await findSourceRecord(input);
  if (!source) {
    return null;
  }

  return deriveStatusDetail(source);
}

export async function createThreadRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  modelSettings?: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  };
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(threads)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      modelSettingsJson: {
        llmProfileAlias: input.modelSettings?.llmProfileAlias ?? null,
        imageProfileAlias: input.modelSettings?.imageProfileAlias ?? null,
        visionProfileAlias: input.modelSettings?.visionProfileAlias ?? null,
      },
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapThread(row);
}


export async function listThreadRecordsByWorkspace(input: {
  teamId: string;
  workspaceId: string;
  limit: number;
  cursor?: {
    id: string;
    updatedAt: string;
  };
}) {
  const cursorDate = input.cursor ? new Date(input.cursor.updatedAt) : null;
  const whereConditions = [
    eq(threads.teamId, input.teamId),
    eq(threads.workspaceId, input.workspaceId),
    eq(threads.archived, false),
  ];

  if (input.cursor && cursorDate) {
    const cursorConditions = or(
      lt(threads.updatedAt, cursorDate),
      and(eq(threads.updatedAt, cursorDate), lt(threads.id, input.cursor.id)),
    );
    if (cursorConditions) {
      whereConditions.push(cursorConditions);
    }
  }

  const rows = await db
    .select()
    .from(threads)
    .where(and(...whereConditions))
    .orderBy(desc(threads.updatedAt), desc(threads.id))
    .limit(input.limit);

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: rows.map((row) => row.id),
  });

  return rows.map((row) => mapThread(row, sourceCounts.get(row.id) ?? 0));
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

  if (!row) {
    return null;
  }

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function updateThreadModelSettingsRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
  modelSettings: {
    llmProfileAlias: string | null;
    imageProfileAlias: string | null;
    visionProfileAlias: string | null;
  };
}) {
  const [row] = await db
    .update(threads)
    .set({
      modelSettingsJson: input.modelSettings,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  if (!row) {
    return null;
  }

  const sourceCounts = await countUsedSourceIdsByThread({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadIds: [row.id],
  });

  return mapThread(row, sourceCounts.get(row.id) ?? 0);
}

export async function createMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  parentMessageId?: string | null;
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
      parentMessageId: input.parentMessageId ?? null,
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

export async function listMessageRecordsByThread(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.teamId, input.teamId),
        eq(messages.workspaceId, input.workspaceId),
        eq(messages.threadId, input.threadId),
      ),
    )
    .orderBy(asc(messages.createdAt));

  return rows.map(mapMessage);
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
  chunks: ChunkSpec[];
  parsingConfig?: ParsingConfig | null;
}) {
  const normalizedText = input.sourceContentText.trim();
  const baseTitle = input.sourceTitle.trim() || "Untitled Source";
  const segments = input.chunks;

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
        chunkSize: input.parsingConfig?.chunkSize ?? null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const chunkIds: string[] = [];
    if (segments.length > 0) {
      const chunkRows = segments.map((segment, index) => {
        const chunkId = randomUUID();
        chunkIds.push(chunkId);
        return {
          id: chunkId,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          documentId,
          chunkNo: index,
          content: segment.text,
          // chonkiejs chunks do not carry heading hierarchy, so structural
          // heading paths stay null until a parser-specific extractor exists.
          headingPath: null,
          startOffset: segment.startIndex,
          endOffset: segment.endIndex,
          language: null,
          chunkMetadata: {
            tokenCount: segment.tokenCount,
          },
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
    where c.workspace_id = ${input.workspaceId}
      and c.team_id = ${input.teamId}
      and c.content ||| ${input.queryText}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
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
    inner join sources s on s.id = c.source_id
    where ce.team_id = ${input.teamId}
      and ce.workspace_id = ${input.workspaceId}
      and ce.embedding_profile_id = ${input.embeddingProfileId}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
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
    inner join sources s on s.id = c.source_id
    where ce.team_id = ${input.teamId}
      and ce.workspace_id = ${input.workspaceId}
      and ce.embedding_profile_id = ${input.embeddingProfileId}
      and c.source_id = any(${toPostgresTextArray(input.sourceIds)}::text[])
      and ce.dim = ${input.dim}
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

export async function createCitationRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  citations: Array<{
    citationKey: string;
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
      citationKey: citation.citationKey,
      quoteText: citation.quoteText,
      rank: citation.rank,
      score: citation.score,
      metadataJson: {},
      createdAt: new Date(),
    })),
  );
}


export async function findCitationByMessageRank(input: {
  teamId: string;
  workspaceId: string;
  messageId: string;
  rank: number;
}) {
  const rows = await db
    .select({
      id: citations.id,
      messageId: citations.messageId,
      sourceId: citations.sourceId,
      documentId: citations.documentId,
      chunkId: citations.chunkId,
      quoteText: citations.quoteText,
      rank: citations.rank,
      score: citations.score,
      sourceTitle: sources.title,
      chunkContent: chunks.content,
    })
    .from(citations)
    .leftJoin(sources, eq(sources.id, citations.sourceId))
    .leftJoin(chunks, eq(chunks.id, citations.chunkId))
    .where(
      and(
        eq(citations.teamId, input.teamId),
        eq(citations.workspaceId, input.workspaceId),
        eq(citations.messageId, input.messageId),
        eq(citations.rank, input.rank),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
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


export async function listByokKeyRefRecords(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  const rows = await db
    .select()
    .from(modelGatewayByokKeyRefs)
    .where(
      and(
        eq(modelGatewayByokKeyRefs.teamId, input.teamId),
        eq(modelGatewayByokKeyRefs.workspaceId, input.workspaceId),
        eq(modelGatewayByokKeyRefs.isActive, true),
      ),
    )
    .orderBy(desc(modelGatewayByokKeyRefs.updatedAt));

  return rows
    .filter((row) => row.userId === null || row.userId === input.userId)
    .map(mapByokKeyRef);
}

export async function createByokKeyRefRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  keyRef: string;
  apiKeyEncrypted: string;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(modelGatewayByokKeyRefs)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
      apiKeyEncrypted: input.apiKeyEncrypted,
      isActive: true,
      metadataJson: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        modelGatewayByokKeyRefs.workspaceId,
        modelGatewayByokKeyRefs.userId,
        modelGatewayByokKeyRefs.providerName,
        modelGatewayByokKeyRefs.keyRef,
      ],
      set: {
        apiKeyEncrypted: input.apiKeyEncrypted,
        isActive: true,
        metadataJson: input.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create BYOK key ref");
  }

  return mapByokKeyRef(row);
}

export async function deleteByokKeyRefRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  keyRef: string;
}) {
  const [row] = await db
    .update(modelGatewayByokKeyRefs)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelGatewayByokKeyRefs.teamId, input.teamId),
        eq(modelGatewayByokKeyRefs.workspaceId, input.workspaceId),
        eq(modelGatewayByokKeyRefs.userId, input.userId),
        eq(modelGatewayByokKeyRefs.providerName, input.providerName),
        eq(modelGatewayByokKeyRefs.keyRef, input.keyRef),
        eq(modelGatewayByokKeyRefs.isActive, true),
      ),
    )
    .returning();

  return row ? mapByokKeyRef(row) : null;
}

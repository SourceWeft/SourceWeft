import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import {
  chunkEmbeddings,
  chunks,
  citations,
  documents,
  sources,
  sourceRevisions,
} from "../../../shared/db/schema";
import type {
  ChunkSpec,
  ParsingConfig,
  SourceDetailRecord,
  SourceMetadata,
  SourceRecord,
  SourceStatus,
} from "../types";
import { buildSearchParts } from "../search-tokenizer";
import { currentDocumentCondition } from "./current-document-condition";
import {
  mapChunk,
  mapSource,
  mapSourceDocument,
  mapSourceEmbedding,
  mapSourceRevision,
} from "./mappers";
import { deriveStatusDetail } from "./status-detail";
export {
  createSourceRevisionRecord,
  findLatestSourceRevisionRecord,
  isLatestSourceRevision,
  listSourceRevisionRecords,
} from "./revision-repository";
export {
  updateSourceStatus,
  updateSourceStatusForLatestRevision,
} from "./status-repository";

const sourceSummaryColumns = {
  id: sources.id,
  teamId: sources.teamId,
  workspaceId: sources.workspaceId,
  ingestKind: sources.ingestKind,
  sourceType: sources.sourceType,
  connectorId: sources.connectorId,
  syncRunId: sources.syncRunId,
  parentSourceId: sources.parentSourceId,
  title: sources.title,
  contentText: sql<string>`''`,
  externalId: sources.externalId,
  externalUri: sources.externalUri,
  externalUpdatedAt: sources.externalUpdatedAt,
  mimeType: sources.mimeType,
  sizeBytes: sources.sizeBytes,
  contentHash: sources.contentHash,
  storageBucket: sources.storageBucket,
  storageKey: sources.storageKey,
  parserVersion: sources.parserVersion,
  parsingConfig: sources.parsingConfig,
  status: sources.status,
  estimatedPages: sources.estimatedPages,
  parsedTokens: sources.parsedTokens,
  errorJson: sources.errorJson,
  metadataJson: sources.metadataJson,
  createdBy: sources.createdBy,
  indexedAt: sources.indexedAt,
  createdAt: sources.createdAt,
  updatedAt: sources.updatedAt,
};

export async function createSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  contentText: string;
  createdBy: string;
  ingestKind?: SourceRecord["ingestKind"];
  estimatedPages?: number;
  parsedTokens?: number;
  sourceType?: SourceRecord["sourceType"];
  parentSourceId?: string | null;
  connectorId?: string | null;
  syncRunId?: string | null;
  externalId?: string | null;
  externalUri?: string | null;
  externalUpdatedAt?: Date | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  parserVersion?: string | null;
  parsingConfig?: ParsingConfig | null;
  status?: SourceStatus;
  indexedAt?: Date | null;
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
      ingestKind: input.ingestKind ?? "manual_upload",
      sourceType: input.sourceType ?? "manual_upload",
      parentSourceId: input.parentSourceId ?? null,
      connectorId: input.connectorId ?? null,
      syncRunId: input.syncRunId ?? null,
      title: input.title,
      contentText: input.contentText,
      externalId: input.externalId ?? null,
      externalUri: input.externalUri ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      contentHash: input.contentHash ?? null,
      storageBucket: input.storageBucket ?? null,
      storageKey: input.storageKey ?? null,
      parserVersion: input.parserVersion ?? null,
      parsingConfig: input.parsingConfig ?? {},
      status: input.status ?? "created",
      estimatedPages: input.estimatedPages ?? null,
      parsedTokens: input.parsedTokens ?? null,
      errorJson: input.error ?? {},
      metadataJson: input.metadata ?? {},
      createdBy: input.createdBy,
      indexedAt: input.indexedAt ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create source");
  }

  return mapSource(row);
}

export async function listSourceRecords(input: {
  view?: "tree" | "page";
  includeContent?: boolean;
  limit?: number;
  cursor?: string;
  parentSourceId?: string | null;
  connectorId?: string;
  syncRunId?: string;
  updatedAfter?: Date;
  teamId: string;
  workspaceId: string;
}) {
  const treeView = input.view === "tree";
  const cursor = treeView ? null : decodeSourceMentionCursor(input.cursor);
  const conditions = [
    eq(sources.teamId, input.teamId),
    eq(sources.workspaceId, input.workspaceId),
    ne(sources.status, "archived"),
  ];

  if (!treeView && input.parentSourceId !== undefined) {
    conditions.push(
      input.parentSourceId === null
        ? sql`${sources.parentSourceId} is null` as never
        : eq(sources.parentSourceId, input.parentSourceId),
    );
  }
  if (input.connectorId) {
    conditions.push(eq(sources.connectorId, input.connectorId));
  }
  if (input.syncRunId) {
    conditions.push(eq(sources.syncRunId, input.syncRunId));
  }
  if (input.updatedAfter) {
    conditions.push(sql`${sources.updatedAt} > ${input.updatedAfter}` as never);
  }

  if (cursor) {
    conditions.push(
      sql`(${sources.updatedAt}, ${sources.id}) < (${cursor.updatedAt}, ${cursor.id})` as never,
    );
  }

  const where = and(...conditions);
  const queryLimit = !treeView && input.limit ? input.limit + 1 : undefined;

  const rows =
    treeView || input.includeContent === false
      ? queryLimit
        ? await db
            .select(sourceSummaryColumns)
            .from(sources)
            .where(where)
            .orderBy(desc(sources.updatedAt), desc(sources.id))
            .limit(queryLimit)
        : await db
            .select(sourceSummaryColumns)
            .from(sources)
            .where(where)
            .orderBy(desc(sources.updatedAt), desc(sources.id))
      : queryLimit
        ? await db
            .select()
            .from(sources)
            .where(where)
            .orderBy(desc(sources.updatedAt), desc(sources.id))
            .limit(queryLimit)
        : await db
            .select()
            .from(sources)
            .where(where)
            .orderBy(desc(sources.updatedAt), desc(sources.id));

  const pageRows = !treeView && input.limit ? rows.slice(0, input.limit) : rows;
  const nextRow = !treeView && input.limit ? rows[input.limit] ?? null : null;

  return {
    items: pageRows.map(mapSource),
    nextCursor: nextRow
      ? encodeSourceMentionCursor({ updatedAt: nextRow.updatedAt, id: nextRow.id })
      : null,
  };
}

function encodeSourceMentionCursor(input: { updatedAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({
      updatedAt: input.updatedAt.toISOString(),
      id: input.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeSourceMentionCursor(cursor: string | undefined) {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { id?: unknown; updatedAt?: unknown };
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      return null;
    }
    return { id: parsed.id, updatedAt };
  } catch {
    return null;
  }
}

export async function listSourceMentionRecords(input: {
  teamId: string;
  workspaceId: string;
  query?: string;
  limit: number;
  cursor?: string;
}) {
  const query = input.query?.trim();
  const cursor = decodeSourceMentionCursor(input.cursor);
  const conditions = [
    eq(sources.teamId, input.teamId),
    eq(sources.workspaceId, input.workspaceId),
    ne(sources.status, "archived"),
    ne(sources.sourceType, "directory"),
  ];

  if (query) {
    const pattern = `%${query.replaceAll(/[%_\\]/g, (match) => `\\${match}`)}%`;
    conditions.push(
      sql`(${sources.title} ilike ${pattern} escape '\\' or coalesce(${sources.mimeType}, '') ilike ${pattern} escape '\\')` as never,
    );
  }

  if (cursor) {
    conditions.push(
      sql`(${sources.updatedAt}, ${sources.id}) < (${cursor.updatedAt}, ${cursor.id})` as never,
    );
  }

  const rows = await db
    .select({
      id: sources.id,
      title: sources.title,
      sourceType: sources.sourceType,
      parentSourceId: sources.parentSourceId,
      mimeType: sources.mimeType,
      status: sources.status,
      storageKey: sources.storageKey,
      updatedAt: sources.updatedAt,
    })
    .from(sources)
    .where(and(...conditions))
    .orderBy(desc(sources.updatedAt), desc(sources.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const nextRow = rows[input.limit] ?? null;
  return {
    items: pageRows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceType: row.sourceType,
      parentSourceId: row.parentSourceId,
      mimeType: row.mimeType,
      status: row.status,
      storageKey: row.storageKey,
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor: nextRow
      ? encodeSourceMentionCursor({
          updatedAt: nextRow.updatedAt,
          id: nextRow.id,
        })
      : null,
  };
}

export async function listSourceRecordsByIds(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
}) {
  if (input.sourceIds.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        inArray(sources.id, input.sourceIds),
        ne(sources.status, "archived"),
      ),
    );

  return rows.map(mapSource);
}

export async function listSourceRecordsByTitles(input: {
  teamId: string;
  workspaceId: string;
  titles: string[];
}) {
  const titles = Array.from(
    new Set(input.titles.map((title) => title.trim()).filter(Boolean)),
  );
  if (titles.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        inArray(sources.title, titles),
        ne(sources.status, "archived"),
      ),
    );

  return rows.map(mapSource);
}

export async function listSourceChildren(input: {
  teamId: string;
  workspaceId: string;
  parentSourceId: string | null;
}) {
  const parentCondition = input.parentSourceId === null
    ? sql`${sources.parentSourceId} is null`
    : eq(sources.parentSourceId, input.parentSourceId);
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        ne(sources.status, "archived"),
        parentCondition,
      ),
    )
    .orderBy(asc(sources.sourceType), asc(sources.title), asc(sources.createdAt));

  return rows.map(mapSource);
}

export async function hasSourceChildren(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.parentSourceId, input.sourceId),
        ne(sources.status, "archived"),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function listSourceDescendants(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
  maxDepth?: number;
}) {
  const maxDepth = input.maxDepth ?? 64;
  const descendants: SourceRecord[] = [];
  const visited = new Set(input.sourceIds);
  let frontier = [...new Set(input.sourceIds)];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const rows = await db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.teamId, input.teamId),
          eq(sources.workspaceId, input.workspaceId),
          inArray(sources.parentSourceId, frontier),
          ne(sources.status, "archived"),
        ),
      )
      .orderBy(asc(sources.createdAt));

    const nextFrontier: string[] = [];
    for (const row of rows) {
      if (visited.has(row.id)) {
        continue;
      }
      visited.add(row.id);
      descendants.push(mapSource(row));
      nextFrontier.push(row.id);
    }
    frontier = nextFrontier;
  }

  return descendants;
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

export async function findSourceRecordByExternalUri(input: {
  teamId: string;
  workspaceId: string;
  sourceType: SourceRecord["sourceType"];
  externalUri: string;
}) {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.sourceType, input.sourceType),
        eq(sources.externalUri, input.externalUri),
        ne(sources.status, "archived"),
      ),
    )
    .limit(1);

  return row ? mapSource(row) : null;
}

export async function findSourceRecordByConnectorExternalId(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  externalId: string;
}) {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.connectorId, input.connectorId),
        eq(sources.externalId, input.externalId),
        ne(sources.status, "archived"),
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
  parentSourceId?: string | null;
  connectorId?: string | null;
  syncRunId?: string | null;
  externalId?: string | null;
  externalUri?: string | null;
  externalUpdatedAt?: Date | null;
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
  indexedAt?: Date | null;
}) {
  const updates: Partial<typeof sources.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (input.title !== undefined) updates.title = input.title;
  if (input.parentSourceId !== undefined) updates.parentSourceId = input.parentSourceId;
  if (input.connectorId !== undefined) updates.connectorId = input.connectorId;
  if (input.syncRunId !== undefined) updates.syncRunId = input.syncRunId;
  if (input.externalId !== undefined) updates.externalId = input.externalId;
  if (input.externalUri !== undefined) updates.externalUri = input.externalUri;
  if (input.externalUpdatedAt !== undefined) updates.externalUpdatedAt = input.externalUpdatedAt;
  if (input.contentText !== undefined) {
    updates.contentText = input.contentText;
    updates.status = "created";
    updates.indexedAt = null;
  }
  if (input.estimatedPages !== undefined) updates.estimatedPages = input.estimatedPages;
  if (input.parsedTokens !== undefined) updates.parsedTokens = input.parsedTokens;
  if (input.mimeType !== undefined) updates.mimeType = input.mimeType;
  if (input.sizeBytes !== undefined) updates.sizeBytes = input.sizeBytes;
  if (input.contentHash !== undefined) updates.contentHash = input.contentHash;
  if (input.storageBucket !== undefined) updates.storageBucket = input.storageBucket;
  if (input.storageKey !== undefined) updates.storageKey = input.storageKey;
  if (input.parserVersion !== undefined) updates.parserVersion = input.parserVersion;
  if (input.parsingConfig !== undefined) updates.parsingConfig = input.parsingConfig ?? {};
  if (input.metadata !== undefined) updates.metadataJson = input.metadata;
  if (input.error !== undefined) updates.errorJson = input.error;
  if (input.status !== undefined) updates.status = input.status;
  if (input.indexedAt !== undefined) updates.indexedAt = input.indexedAt;

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

export async function updateSourceRecordForLatestRevision(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  sourceRevisionId: string;
  title?: string;
  contentText?: string;
  parentSourceId?: string | null;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  parserVersion?: string | null;
  parsingConfig?: ParsingConfig | null;
  metadata?: SourceMetadata;
  error?: Record<string, unknown>;
  status?: SourceStatus;
}) {
  const updates: Partial<typeof sources.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (input.title !== undefined) updates.title = input.title;
  if (input.parentSourceId !== undefined) updates.parentSourceId = input.parentSourceId;
  if (input.contentText !== undefined) {
    updates.contentText = input.contentText;
    updates.status = "created";
    updates.indexedAt = null;
  }
  if (input.estimatedPages !== undefined) updates.estimatedPages = input.estimatedPages;
  if (input.parsedTokens !== undefined) updates.parsedTokens = input.parsedTokens;
  if (input.sizeBytes !== undefined) updates.sizeBytes = input.sizeBytes;
  if (input.contentHash !== undefined) updates.contentHash = input.contentHash;
  if (input.parserVersion !== undefined) updates.parserVersion = input.parserVersion;
  if (input.parsingConfig !== undefined) updates.parsingConfig = input.parsingConfig ?? {};
  if (input.metadata !== undefined) updates.metadataJson = input.metadata;
  if (input.error !== undefined) updates.errorJson = input.error;
  if (input.status !== undefined) updates.status = input.status;

  const [row] = await db
    .update(sources)
    .set(updates)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        sql`exists (
          select 1
          from ${sourceRevisions}
          where ${sourceRevisions.id} = ${input.sourceRevisionId}
            and ${sourceRevisions.teamId} = ${input.teamId}
            and ${sourceRevisions.workspaceId} = ${input.workspaceId}
            and ${sourceRevisions.sourceId} = ${input.sourceId}
            and ${sourceRevisions.isLatest} = true
        )`,
      ),
    )
    .returning();

  return row ? mapSource(row) : null;
}

function preserveSourceCitationsSql(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  externalUriPrefix: string;
}) {
  return sql`
    update ${citations} as citation
    set
      external_uri = coalesce(
        citation.external_uri,
        ${input.externalUriPrefix} || '/citation/' || citation.id
      ),
      metadata_json = citation.metadata_json || jsonb_strip_nulls(jsonb_build_object(
        'sourceTitle', coalesce(
          citation.metadata_json->>'sourceTitle',
          (
            select ${sources.title}
            from ${sources}
            where ${sources.id} = ${input.sourceId}
              and ${sources.teamId} = ${input.teamId}
              and ${sources.workspaceId} = ${input.workspaceId}
            limit 1
          )
        ),
        'chunkNo', (
          select ${chunks.chunkNo}
          from ${chunks}
          where ${chunks.id} = citation.chunk_id
          limit 1
        ),
        'excerpt', coalesce(
          citation.metadata_json->>'excerpt',
          citation.quote_text,
          left((
            select ${chunks.content}
            from ${chunks}
            where ${chunks.id} = citation.chunk_id
            limit 1
          ), 320)
        )
      ))
    where citation.team_id = ${input.teamId}
      and citation.workspace_id = ${input.workspaceId}
      and (
        citation.source_id = ${input.sourceId}
        or citation.chunk_id in (
          select ${chunks.id}
          from ${chunks}
          where ${chunks.teamId} = ${input.teamId}
            and ${chunks.workspaceId} = ${input.workspaceId}
            and ${chunks.sourceId} = ${input.sourceId}
        )
      )
  `;
}

export async function updateSourceRecordAndInvalidateDocuments(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  title?: string;
  contentText: string;
  parentSourceId?: string | null;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  status?: SourceStatus;
  indexedAt?: Date | null;
}) {
  return db.transaction(async (tx) => {
    const updates: Partial<typeof sources.$inferInsert> & { updatedAt: Date } = {
      contentText: input.contentText,
      status: "created",
      indexedAt: null,
      updatedAt: new Date(),
    };

    if (input.title !== undefined) updates.title = input.title;
    if (input.parentSourceId !== undefined) updates.parentSourceId = input.parentSourceId;
    if (input.estimatedPages !== undefined) updates.estimatedPages = input.estimatedPages;
    if (input.parsedTokens !== undefined) updates.parsedTokens = input.parsedTokens;
    if (input.status !== undefined) updates.status = input.status;
    if (input.indexedAt !== undefined) updates.indexedAt = input.indexedAt;

    const [row] = await tx
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
      return null;
    }

    await tx.execute(
      preserveSourceCitationsSql({
        ...input,
        externalUriPrefix: `sourceweft://updated-source/${input.sourceId}`,
      }),
    );

    await tx
      .delete(documents)
      .where(
        and(
          eq(documents.sourceId, input.sourceId),
          eq(documents.teamId, input.teamId),
          eq(documents.workspaceId, input.workspaceId),
        ),
      );

    return mapSource(row);
  });
}

export async function deleteSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      preserveSourceCitationsSql({
        ...input,
        externalUriPrefix: `sourceweft://deleted-source/${input.sourceId}`,
      }),
    );

    const rows = await tx
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
  });
}

export async function getSourceDetailRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}): Promise<SourceDetailRecord | null> {
  const source = await findSourceRecord(input);
  if (!source) return null;

  const [documentRows, revisionRows] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.sourceId, input.sourceId),
          eq(documents.teamId, input.teamId),
          eq(documents.workspaceId, input.workspaceId),
          currentDocumentCondition(),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.updatedAt), desc(documents.id)),
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

  const currentDocument = documentRows[0] ?? null;
  const [chunkRows, embeddingRows] = currentDocument
    ? await Promise.all([
        db
          .select()
          .from(chunks)
          .where(
            and(
              eq(chunks.documentId, currentDocument.id),
              eq(chunks.teamId, input.teamId),
              eq(chunks.workspaceId, input.workspaceId),
            ),
          )
          .orderBy(asc(chunks.chunkNo)),
        db
          .select({ embedding: chunkEmbeddings })
          .from(chunkEmbeddings)
          .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
          .where(
            and(
              eq(chunks.documentId, currentDocument.id),
              eq(chunkEmbeddings.teamId, input.teamId),
              eq(chunkEmbeddings.workspaceId, input.workspaceId),
            ),
          )
          .orderBy(asc(chunkEmbeddings.createdAt)),
      ])
    : [[], []];

  return {
    source,
    documents: currentDocument ? [mapSourceDocument(currentDocument)] : [],
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

export async function getSourceDocumentDetailRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  documentId: string;
}): Promise<SourceDetailRecord | null> {
  const source = await findSourceRecord(input);
  if (!source) return null;

  const [documentRow] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, input.documentId),
        eq(documents.sourceId, input.sourceId),
        eq(documents.teamId, input.teamId),
        eq(documents.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (!documentRow) return null;

  const [chunkRows, embeddingRows, revisionRows] = await Promise.all([
    db
      .select()
      .from(chunks)
      .where(
        and(
          eq(chunks.documentId, documentRow.id),
          eq(chunks.teamId, input.teamId),
          eq(chunks.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(chunks.chunkNo)),
    db
      .select({ embedding: chunkEmbeddings })
      .from(chunkEmbeddings)
      .innerJoin(chunks, eq(chunkEmbeddings.chunkId, chunks.id))
      .where(
        and(
          eq(chunks.documentId, documentRow.id),
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
    documents: [mapSourceDocument(documentRow)],
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

export async function listSourceChunks(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const rows = await db
    .select({ chunk: chunks })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(
      and(
        eq(chunks.teamId, input.teamId),
        eq(chunks.workspaceId, input.workspaceId),
        eq(chunks.sourceId, input.sourceId),
        currentDocumentCondition(),
      ),
    )
    .orderBy(asc(chunks.chunkNo));

  return rows.map((row) => mapChunk(row.chunk));
}

export async function getSourceStatusDetail(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const source = await findSourceRecord(input);
  if (!source) return null;

  return deriveStatusDetail(source);
}

export async function createSourceDocumentChunksAndEmbeddings(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  sourceRevisionId: string | null;
  sourceTitle: string;
  sourceContentText: string;
  embeddingProfileId: string;
  modelAlias: string;
  embeddings: number[][];
  requireEmbeddings: boolean;
  requestedDimensions: number | null;
  chunks: ChunkSpec[];
  parsingConfig?: ParsingConfig | null;
  markSourceIndexed?: boolean;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
}) {
  const normalizedText = input.sourceContentText.trim();
  const baseTitle = input.sourceTitle.trim() || "Untitled Source";
  const segments = input.chunks;

  const now = new Date();

  return db.transaction(async (tx) => {
    if (input.sourceRevisionId) {
      const [latestRevision] = await tx
        .select({ id: sourceRevisions.id })
        .from(sourceRevisions)
        .where(
          and(
            eq(sourceRevisions.id, input.sourceRevisionId),
            eq(sourceRevisions.teamId, input.teamId),
            eq(sourceRevisions.workspaceId, input.workspaceId),
            eq(sourceRevisions.sourceId, input.sourceId),
            eq(sourceRevisions.isLatest, true),
          ),
        )
        .limit(1);

      if (!latestRevision) {
        return null;
      }
    }

    await tx.execute(sql`
      delete from ${chunkEmbeddings}
      where ${chunkEmbeddings.teamId} = ${input.teamId}
        and ${chunkEmbeddings.workspaceId} = ${input.workspaceId}
        and ${chunkEmbeddings.chunkId} in (
          select ${chunks.id}
          from ${chunks}
          where ${chunks.teamId} = ${input.teamId}
            and ${chunks.workspaceId} = ${input.workspaceId}
            and ${chunks.sourceId} = ${input.sourceId}
        )
    `);

    const documentId = randomUUID();
    await tx.insert(documents).values({
      id: documentId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceRevisionId: input.sourceRevisionId ?? null,
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
          headingPath: null,
          startOffset: segment.startIndex,
          endOffset: segment.endIndex,
          language: null,
          searchParts: buildSearchParts(segment.text),
          chunkMetadata: {
            tokenCount: segment.tokenCount,
          },
          createdAt: now,
        };
      });

      await tx.insert(chunks).values(chunkRows);

      if (
        (input.requireEmbeddings || input.embeddings.length > 0) &&
        input.embeddings.length !== chunkRows.length
      ) {
        throw new Error("Embedding count does not match chunk count");
      }

      if (input.embeddings.length > 0) {
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
    }

    let source: SourceRecord | null = null;
    if (input.markSourceIndexed) {
      const [row] = await tx
        .update(sources)
        .set({
          status: "indexed",
          indexedAt: now,
          updatedAt: now,
          estimatedPages: input.estimatedPages ?? null,
          parsedTokens: input.parsedTokens ?? null,
        })
        .where(
          and(
            eq(sources.id, input.sourceId),
            eq(sources.teamId, input.teamId),
            eq(sources.workspaceId, input.workspaceId),
            input.sourceRevisionId
              ? sql`exists (
                  select 1
                  from ${sourceRevisions}
                  where ${sourceRevisions.id} = ${input.sourceRevisionId}
                    and ${sourceRevisions.teamId} = ${input.teamId}
                    and ${sourceRevisions.workspaceId} = ${input.workspaceId}
                    and ${sourceRevisions.sourceId} = ${input.sourceId}
                    and ${sourceRevisions.isLatest} = true
                )`
              : sql`true`,
          ),
        )
        .returning();

      if (!row) {
        return null;
      }

      source = mapSource(row);
    }

    return {
      documentId,
      chunkIds,
      chunkCount: segments.length,
      source,
    };
  });
}

import { and, asc, eq, inArray } from "drizzle-orm";
import { chunks, db, documents, sources } from "@sourceweft/db";
import { currentDocumentCondition } from "../sources/current-document-condition";
import { sourceVersionToken } from "./freshness";
import {
  GroundedGenerationError,
  type GroundedCorpusChunk,
} from "@sourceweft/contracts/grounded-generation";

/** What a version was generated from, kept for staleness and attribution. */
export type GroundedSourceSnapshot = {
  sourceId: string;
  documentId: string;
  title: string;
  /**
   * The source's version token at generation time (`sourceVersionToken`):
   * its content hash, or its current revision or document when it has none.
   */
  contentHash: string;
};

export type GroundedCorpus = {
  chunks: GroundedCorpusChunk[];
  sources: GroundedSourceSnapshot[];
};

/**
 * The cheap check a request makes before anything is queued: every source is
 * in this workspace (`SOURCE_NOT_READABLE` otherwise) and at least one is
 * indexed (`NO_INDEXED_SOURCES`). Returns the titles in selection order.
 */
export async function checkGroundedSources(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<{ sourceId: string; title: string; indexed: boolean }[]> {
  const sourceIds = [...new Set(input.sourceIds)];
  const rows = sourceIds.length
    ? await db
        .select({ id: sources.id, title: sources.title, status: sources.status })
        .from(sources)
        .where(
          and(
            eq(sources.teamId, input.teamId),
            eq(sources.workspaceId, input.workspaceId),
            inArray(sources.id, sourceIds),
          ),
        )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = sourceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new GroundedGenerationError(
      "SOURCE_NOT_READABLE",
      "Some selected sources do not exist in this workspace",
      { sourceIds: missing },
    );
  }
  const result = sourceIds.map((id) => ({
    sourceId: id,
    title: byId.get(id)!.title,
    indexed: byId.get(id)!.status === "indexed",
  }));
  if (!result.some((source) => source.indexed)) {
    throw new GroundedGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources is indexed yet",
    );
  }
  return result;
}

/**
 * Loads the current document's chunks of every selected source, in selection
 * order. Every source must belong to this workspace (sources carry no
 * visibility of their own; the workspace is the boundary), otherwise
 * `SOURCE_NOT_READABLE`. Sources that are not indexed contribute nothing; if
 * none is left the result is `NO_INDEXED_SOURCES`.
 */
export async function loadGroundedCorpus(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<GroundedCorpus> {
  const sourceIds = [...new Set(input.sourceIds)];
  const rows = sourceIds.length
    ? await db
        .select({
          id: sources.id,
          title: sources.title,
          status: sources.status,
          contentHash: sources.contentHash,
        })
        .from(sources)
        .where(
          and(
            eq(sources.teamId, input.teamId),
            eq(sources.workspaceId, input.workspaceId),
            inArray(sources.id, sourceIds),
          ),
        )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = sourceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new GroundedGenerationError(
      "SOURCE_NOT_READABLE",
      "Some selected sources do not exist in this workspace",
      { sourceIds: missing },
    );
  }

  const indexed = sourceIds.filter((id) => byId.get(id)!.status === "indexed");
  if (indexed.length === 0) {
    throw new GroundedGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources is indexed yet",
    );
  }

  const chunkRows = await db
    .select({
      chunkId: chunks.id,
      sourceId: chunks.sourceId,
      documentId: chunks.documentId,
      revisionId: documents.sourceRevisionId,
      chunkNo: chunks.chunkNo,
      headingPath: chunks.headingPath,
      language: chunks.language,
      text: chunks.content,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(
      and(
        eq(chunks.teamId, input.teamId),
        eq(chunks.workspaceId, input.workspaceId),
        inArray(chunks.sourceId, indexed),
        currentDocumentCondition(),
      ),
    )
    .orderBy(asc(chunks.chunkNo));

  const order = new Map(indexed.map((id, index) => [id, index]));
  const ordered = chunkRows
    .filter((row) => row.text.trim().length > 0)
    .sort(
      (a, b) =>
        order.get(a.sourceId)! - order.get(b.sourceId)! || a.chunkNo - b.chunkNo,
    );
  if (ordered.length === 0) {
    throw new GroundedGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources has indexed text",
    );
  }

  const documentBySource = new Map<string, { documentId: string; revisionId: string | null }>();
  for (const row of ordered) {
    if (!documentBySource.has(row.sourceId)) {
      documentBySource.set(row.sourceId, {
        documentId: row.documentId,
        revisionId: row.revisionId,
      });
    }
  }
  const snapshots: GroundedSourceSnapshot[] = indexed
    .filter((id) => documentBySource.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      const document = documentBySource.get(id)!;
      return {
        sourceId: id,
        documentId: document.documentId,
        title: row.title,
        contentHash: sourceVersionToken({
          contentHash: row.contentHash,
          revisionId: document.revisionId,
          documentId: document.documentId,
        }),
      };
    });

  // The revision only feeds the version token; chunks keep their own shape.
  const corpusChunks: GroundedCorpusChunk[] = ordered.map((row) => ({
    chunkId: row.chunkId,
    sourceId: row.sourceId,
    documentId: row.documentId,
    chunkNo: row.chunkNo,
    headingPath: row.headingPath,
    language: row.language,
    text: row.text,
  }));
  return { chunks: corpusChunks, sources: snapshots };
}

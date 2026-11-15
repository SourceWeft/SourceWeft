import { and, asc, eq, inArray } from "drizzle-orm";
import { chunks, db, documents, sources } from "@sourceweft/db";
import { currentDocumentCondition } from "../sources/current-document-condition";
import {
  StudyGenerationError,
  type StudyCorpusChunk,
} from "@sourceweft/contracts/study-capability";

/** What a version was generated from, kept for staleness and attribution. */
export type StudySourceSnapshot = {
  sourceId: string;
  documentId: string;
  title: string;
  /** `sources.content_hash` at generation time. */
  contentHash: string;
};

export type StudyCorpus = {
  chunks: StudyCorpusChunk[];
  sources: StudySourceSnapshot[];
};

/**
 * Loads the current document's chunks of every selected source, in selection
 * order. Every source must belong to this workspace (sources carry no
 * visibility of their own; the workspace is the boundary), otherwise
 * `SOURCE_NOT_READABLE`. Sources that are not indexed contribute nothing; if
 * none is left the result is `NO_INDEXED_SOURCES`.
 */
export async function loadStudyCorpus(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<StudyCorpus> {
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
    throw new StudyGenerationError(
      "SOURCE_NOT_READABLE",
      "Some selected sources do not exist in this workspace",
      { sourceIds: missing },
    );
  }

  const indexed = sourceIds.filter((id) => byId.get(id)!.status === "indexed");
  if (indexed.length === 0) {
    throw new StudyGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources is indexed yet",
    );
  }

  const chunkRows = await db
    .select({
      chunkId: chunks.id,
      sourceId: chunks.sourceId,
      documentId: chunks.documentId,
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
    throw new StudyGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources has indexed text",
    );
  }

  const documentBySource = new Map<string, string>();
  for (const row of ordered) {
    if (!documentBySource.has(row.sourceId)) {
      documentBySource.set(row.sourceId, row.documentId);
    }
  }
  const snapshots: StudySourceSnapshot[] = indexed
    .filter((id) => documentBySource.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      return {
        sourceId: id,
        documentId: documentBySource.get(id)!,
        title: row.title,
        // An indexed source always has a hash; "unknown" keeps the snapshot
        // valid and simply reads as stale against any real hash later.
        contentHash: row.contentHash ?? "unknown",
      };
    });

  return { chunks: ordered, sources: snapshots };
}

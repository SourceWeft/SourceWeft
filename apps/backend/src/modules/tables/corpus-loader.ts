import { and, desc, eq, inArray } from "drizzle-orm";
import { db, documents, sources } from "@sourceweft/db";
import type { TableSourceInput } from "@sourceweft/contracts/table-capability";
import { currentDocumentCondition } from "../sources/current-document-condition";
import {
  checkGroundedSources,
  loadGroundedCorpus,
  type GroundedSourceSnapshot,
} from "../grounded-generation/corpus-loader";

export type TableSources = {
  /** One entry per selected source, in selection order. */
  sources: TableSourceInput[];
  /** The sources that were read, for attribution; skipped sources have none. */
  snapshots: GroundedSourceSnapshot[];
};

/**
 * The selected sources as a table reads them. Unlike a study corpus, a table
 * keeps one row per selected source: one that is not indexed yet (or holds no
 * text) is returned with `indexed: false` and no chunks, and its row becomes
 * `skipped`. Every source must belong to this workspace
 * (`SOURCE_NOT_READABLE`) and at least one must be readable
 * (`NO_INDEXED_SOURCES`). A skipped source's hash is "unknown" until it has
 * one, so it reads as changed against any real hash later.
 */
export async function loadTableSources(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<TableSources> {
  const selected = await checkGroundedSources(input);
  const corpus = await loadGroundedCorpus({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceIds: selected.filter((source) => source.indexed).map((source) => source.sourceId),
  });
  const chunksBySource = new Map<string, typeof corpus.chunks>();
  for (const chunk of corpus.chunks) {
    const list = chunksBySource.get(chunk.sourceId) ?? [];
    list.push(chunk);
    chunksBySource.set(chunk.sourceId, list);
  }
  const snapshotById = new Map(corpus.sources.map((source) => [source.sourceId, source]));

  const restIds = selected
    .filter((source) => !snapshotById.has(source.sourceId))
    .map((source) => source.sourceId);
  const scope = and(
    eq(sources.teamId, input.teamId),
    eq(sources.workspaceId, input.workspaceId),
  );
  const restRows = restIds.length
    ? await db
        .select({ id: sources.id, contentHash: sources.contentHash })
        .from(sources)
        .where(and(scope, inArray(sources.id, restIds)))
    : [];
  const restHash = new Map(restRows.map((row) => [row.id, row.contentHash]));
  const restDocuments = restIds.length
    ? await db
        .select({ sourceId: documents.sourceId, id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.teamId, input.teamId),
            eq(documents.workspaceId, input.workspaceId),
            inArray(documents.sourceId, restIds),
            currentDocumentCondition(),
          ),
        )
        .orderBy(desc(documents.createdAt), desc(documents.id))
    : [];
  const restDocument = new Map<string, string>();
  for (const row of restDocuments) {
    if (row.sourceId && !restDocument.has(row.sourceId)) {
      restDocument.set(row.sourceId, row.id);
    }
  }

  return {
    sources: selected.map((source): TableSourceInput => {
      const snapshot = snapshotById.get(source.sourceId);
      if (snapshot) {
        return {
          sourceId: source.sourceId,
          documentId: snapshot.documentId,
          title: snapshot.title,
          contentHash: snapshot.contentHash,
          indexed: true,
          chunks: chunksBySource.get(source.sourceId) ?? [],
        };
      }
      return {
        sourceId: source.sourceId,
        // A source still being parsed may have no document yet; the row then
        // names the source itself, which is all a skipped row needs.
        documentId: restDocument.get(source.sourceId) ?? source.sourceId,
        title: source.title,
        contentHash: restHash.get(source.sourceId) ?? "unknown",
        indexed: false,
        chunks: [],
      };
    }),
    snapshots: selected.flatMap((source) => snapshotById.get(source.sourceId) ?? []),
  };
}

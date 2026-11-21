import { and, desc, eq, inArray } from "drizzle-orm";
import { db, documents, sources } from "@sourceweft/db";
import { currentDocumentCondition } from "../sources/current-document-condition";

/**
 * What a version remembers about a source to tell later whether it changed.
 * Only sources whose text is known up front (notes, pasted text, web pages)
 * carry `sources.content_hash`; uploaded files and connector files do not. For
 * those the source's current revision stands for its content (a new upload or
 * sync makes a new revision; a parse retry stays on the same one), and a
 * source with no revision is marked by its current document. A source with
 * none of these (not parsed yet) is "unknown", which reads as changed once it
 * has any of them.
 */
export function sourceVersionToken(input: {
  contentHash: string | null;
  revisionId?: string | null;
  documentId?: string | null;
}): string {
  if (input.contentHash) return input.contentHash;
  if (input.revisionId) return `revision:${input.revisionId}`;
  if (input.documentId) return `document:${input.documentId}`;
  return "unknown";
}

/** The part of a version's input snapshot that freshness reads. */
export type FreshnessInputs = {
  sources: readonly { sourceId: string; contentHash: string }[];
};

export type InputFreshness = {
  state: "fresh" | "stale" | "source_deleted";
  changedSourceIds: string[];
  deletedSourceIds: string[];
};

/**
 * Compares a version's input snapshot with the sources as they are now. A
 * deleted source outranks a changed one; nothing is regenerated automatically.
 */
export function compareInputFreshness<I extends FreshnessInputs>(
  inputs: I,
  current: ReadonlyMap<string, string | null>,
): InputFreshness {
  const changedSourceIds: string[] = [];
  const deletedSourceIds: string[] = [];
  for (const source of inputs.sources) {
    if (!current.has(source.sourceId)) {
      deletedSourceIds.push(source.sourceId);
    } else if (current.get(source.sourceId) !== source.contentHash) {
      changedSourceIds.push(source.sourceId);
    }
  }
  return {
    state:
      deletedSourceIds.length > 0
        ? "source_deleted"
        : changedSourceIds.length > 0
          ? "stale"
          : "fresh",
    changedSourceIds,
    deletedSourceIds,
  };
}

/** Freshness of a version's inputs against the sources in its workspace. */
export async function loadInputFreshness<I extends FreshnessInputs>(input: {
  teamId: string;
  workspaceId: string;
  inputs: I;
}): Promise<InputFreshness> {
  return compareInputFreshness(
    input.inputs,
    await loadSourceVersionTokens({
      ...input,
      ids: input.inputs.sources.map((source) => source.sourceId),
    }),
  );
}

/**
 * The version token of each source as it is now (see `sourceVersionToken`).
 * A source missing from the map no longer exists in this workspace.
 */
export async function loadSourceVersionTokens(input: {
  teamId: string;
  workspaceId: string;
  ids: readonly string[];
}): Promise<Map<string, string>> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: sources.id, contentHash: sources.contentHash })
    .from(sources)
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        inArray(sources.id, ids),
      ),
    );
  const unhashed = rows.filter((row) => !row.contentHash).map((row) => row.id);
  const current = new Map<
    string,
    { documentId: string; revisionId: string | null }
  >();
  if (unhashed.length > 0) {
    const documentRows = await db
      .select({
        sourceId: documents.sourceId,
        id: documents.id,
        revisionId: documents.sourceRevisionId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.teamId, input.teamId),
          eq(documents.workspaceId, input.workspaceId),
          inArray(documents.sourceId, unhashed),
          currentDocumentCondition(),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id));
    for (const row of documentRows) {
      if (row.sourceId && !current.has(row.sourceId)) {
        current.set(row.sourceId, {
          documentId: row.id,
          revisionId: row.revisionId,
        });
      }
    }
  }
  return new Map(
    rows.map((row) => {
      const document = current.get(row.id);
      return [
        row.id,
        sourceVersionToken({
          contentHash: row.contentHash,
          revisionId: document?.revisionId ?? null,
          documentId: document?.documentId ?? null,
        }),
      ];
    }),
  );
}

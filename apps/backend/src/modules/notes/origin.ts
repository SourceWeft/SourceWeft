import { and, eq, inArray } from "drizzle-orm";
import { db, notes, sources } from "@sourceweft/db";
import type { NoteOrigin } from "@sourceweft/contracts/sources";
import { ContentError } from "../content/errors";
import { requireContentSource } from "../sources";
import { findThreadRecord } from "../threads";
import { canViewThread } from "../workspace/content-visibility";

type StoredReference = {
  number?: unknown;
  sourceTitle?: unknown;
  sourceId?: unknown;
  externalUri?: unknown;
  passage?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Where a saved note came from: the conversation (shown only to someone who
 * can read it), when it was saved and last edited, and the sources the answer
 * cited with the passage that supported each claim at the time. The references
 * are the snapshot taken when the note was saved, so editing the note's text
 * does not change them.
 */
export async function getNoteOrigin(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}): Promise<NoteOrigin | null> {
  const { workspace, source } = await requireContentSource(input);
  if (source.sourceType !== "note") {
    throw new ContentError(404, "NOTE_NOT_FOUND", "This source is not a note");
  }

  const [note] = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.teamId, workspace.organizationId),
        eq(notes.workspaceId, workspace.id),
        eq(notes.sourceId, source.id),
      ),
    )
    .limit(1);
  if (!note) return null;

  const thread = note.threadId
    ? await findThreadRecord({
        threadId: note.threadId,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
      })
    : null;
  const readableThread =
    thread && canViewThread(input.userId, thread)
      ? { id: thread.id, title: thread.title }
      : null;

  const stored = Array.isArray(
    (note.contentJson as { references?: unknown }).references,
  )
    ? ((note.contentJson as { references: StoredReference[] }).references ?? [])
    : [];
  const citedIds = [
    ...new Set(
      stored
        .map((reference) => text(reference.sourceId))
        .filter((id): id is string => id !== null),
    ),
  ];
  const existing = new Set<string>();
  if (citedIds.length > 0) {
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.teamId, workspace.organizationId),
          eq(sources.workspaceId, workspace.id),
          inArray(sources.id, citedIds),
        ),
      );
    for (const row of rows) existing.add(row.id);
  }

  return {
    noteId: note.id,
    thread: readableThread,
    messageId: readableThread ? note.sourceMessageId : null,
    savedAt: note.createdAt.toISOString(),
    editedAt:
      note.updatedAt.getTime() - note.createdAt.getTime() > 1000
        ? note.updatedAt.toISOString()
        : null,
    references: stored.map((reference, index) => {
      const sourceId = text(reference.sourceId);
      return {
        number:
          typeof reference.number === "number" && reference.number > 0
            ? reference.number
            : index + 1,
        sourceTitle: text(reference.sourceTitle),
        sourceId,
        externalUri: text(reference.externalUri),
        passage: text(reference.passage),
        sourceExists: sourceId !== null && existing.has(sourceId),
      };
    }),
  };
}

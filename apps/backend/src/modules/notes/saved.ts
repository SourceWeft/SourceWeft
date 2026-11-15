import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, notes, threads } from "@sourceweft/db";
import type { ListSavedNotesResponse } from "@sourceweft/contracts/sources";
import { requireContentWorkspace } from "../workspace/guards";
import { canViewThread } from "../workspace/content-visibility";

/**
 * Which of these messages have been saved as notes, so the chat can keep
 * showing "Saved as note" after a reload. A message in a conversation the
 * viewer cannot read is never reported, so this cannot reveal that someone
 * else's private answer was saved.
 */
export async function listSavedNotes(input: {
  workspaceId: string;
  userId: string;
  messageIds: string[];
}): Promise<ListSavedNotesResponse> {
  const workspace = await requireContentWorkspace(input);
  const rows = await db
    .select({
      noteId: notes.id,
      sourceId: notes.sourceId,
      title: notes.title,
      messageId: notes.sourceMessageId,
      visibility: threads.visibility,
      createdBy: threads.createdBy,
    })
    .from(notes)
    .innerJoin(threads, eq(threads.id, notes.threadId))
    .where(
      and(
        eq(notes.teamId, workspace.organizationId),
        eq(notes.workspaceId, workspace.id),
        eq(notes.noteType, "saved_response"),
        isNotNull(notes.sourceId),
        inArray(notes.sourceMessageId, input.messageIds),
      ),
    );

  const result: ListSavedNotesResponse["notes"] = {};
  for (const row of rows) {
    if (!row.messageId || !row.sourceId) continue;
    if (!canViewThread(input.userId, row)) continue;
    result[row.messageId] = {
      noteId: row.noteId,
      sourceId: row.sourceId,
      title: row.title ?? "",
    };
  }
  return { notes: result };
}

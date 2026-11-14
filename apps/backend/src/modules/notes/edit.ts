import { and, eq } from "drizzle-orm";
import { db, notes } from "@sourceweft/db";
import { ContentError } from "../content/errors";
import {
  contentSourceService,
  findSourceRecord,
  requireContentSource,
  sourceIndexingService,
} from "../sources";
import { computeContentHash } from "../sources/content-hash";

/**
 * Replaces a note's text and indexes it again, so what is searched and cited
 * is what the note now says. The re-index is charged to the person editing, as
 * ingestion pages like any other source (a note is normally one page).
 *
 * The edit is refused when someone else changed the note since this one began
 * (`expectedUpdatedAt`), so two edits never silently overwrite each other. The
 * text is saved before indexing: if indexing fails the new text is kept, the
 * note shows as failed, and saving again retries it.
 */
export async function updateNoteContent(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
  contentText: string;
  expectedUpdatedAt: string;
}): Promise<{ updatedAt: string }> {
  const { workspace, source } = await requireContentSource(input);
  if (source.sourceType !== "note") {
    throw new ContentError(404, "NOTE_NOT_FOUND", "This source is not a note");
  }
  if (source.updatedAt !== input.expectedUpdatedAt) {
    throw new ContentError(
      409,
      "NOTE_CONFLICT",
      "This note was changed by someone else. Reload it and edit again.",
    );
  }

  const contentHash = computeContentHash(input.contentText);
  if (contentHash === source.contentHash && source.status === "indexed") {
    return { updatedAt: source.updatedAt };
  }

  await contentSourceService.updateSource({
    workspaceId: workspace.id,
    sourceId: source.id,
    userId: input.userId,
    contentText: input.contentText,
  });
  await sourceIndexingService.indexSource({
    workspaceId: workspace.id,
    sourceId: source.id,
    userId: input.userId,
    // Each distinct text is its own piece of ingestion; reusing the source's
    // default key would treat an edit as already settled and charge nothing.
    idempotencyKey: `note-edit:${source.id}:${contentHash}`,
  });

  await db
    .update(notes)
    .set({ contentText: input.contentText, updatedAt: new Date() })
    .where(
      and(
        eq(notes.teamId, workspace.organizationId),
        eq(notes.workspaceId, workspace.id),
        eq(notes.sourceId, source.id),
      ),
    );

  const updated = await findSourceRecord({
    sourceId: source.id,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });
  return { updatedAt: updated?.updatedAt ?? new Date().toISOString() };
}

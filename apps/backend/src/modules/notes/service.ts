import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, noteSources, notes } from "@sourceweft/db";
import type { SavedAnswerNote } from "@sourceweft/contracts/sources";
import { ContentError } from "../content/errors";
import { normalizeContentTitle } from "../../shared/strings";
import { logger } from "../../shared/logger";
import {
  contentSourceService,
  createSourceRecord,
  sourceIndexingService,
} from "../sources";
import { contentThreadService, findMessageRecord } from "../threads";
import { requireContentWorkspace } from "../workspace/guards";
import {
  rewriteCitationsForNote,
  type NoteCitationInput,
} from "./citation-rewrite";

const TITLE_MAX_CHARS = 80;

/** A short title from the answer's first line: its first sentence, or a word-boundary cut. */
export function noteTitle(content: string) {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? "";
  const clean = firstLine
    .replace(/\[citation:[^\]]*\]/g, "")
    .replace(/\s+([，。,.;；!?！？])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = clean.match(/^.+?[.!?。！？](?=\s|$)/)?.[0] ?? clean;
  if (sentence.length <= TITLE_MAX_CHARS) {
    return normalizeContentTitle(
      sentence.replace(/[.。]$/, ""),
      "Saved answer",
    );
  }
  const cut = sentence.slice(0, TITLE_MAX_CHARS);
  const atWord = cut.lastIndexOf(" ");
  const trimmed = (
    atWord > TITLE_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut
  ).trimEnd();
  return `${trimmed}…`;
}

function readMessageCitations(metadata: unknown): NoteCitationInput[] {
  const retrieval = (metadata as { retrieval?: { citations?: unknown } })
    ?.retrieval;
  if (!Array.isArray(retrieval?.citations)) return [];
  const result: NoteCitationInput[] = [];
  for (const item of retrieval.citations as Array<Record<string, unknown>>) {
    if (typeof item?.citation !== "string") continue;
    result.push({
      citation: item.citation,
      sourceId: typeof item.sourceId === "string" ? item.sourceId : null,
      sourceTitle:
        typeof item.sourceTitle === "string" ? item.sourceTitle : undefined,
      chunkId: typeof item.chunkId === "string" ? item.chunkId : undefined,
      externalUri:
        typeof item.externalUri === "string" ? item.externalUri : undefined,
      excerpt: typeof item.excerpt === "string" ? item.excerpt : undefined,
      spanText: typeof item.spanText === "string" ? item.spanText : undefined,
    });
  }
  return result;
}

async function findSavedNote(input: { teamId: string; messageId: string }) {
  const [row] = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.teamId, input.teamId),
        eq(notes.sourceMessageId, input.messageId),
        eq(notes.noteType, "saved_response"),
      ),
    )
    .limit(1);
  return row ?? null;
}

function toResult(
  row: { id: string; sourceId: string | null; title: string | null },
  alreadySaved: boolean,
): SavedAnswerNote {
  return {
    noteId: row.id,
    sourceId: row.sourceId ?? "",
    title: row.title ?? "",
    alreadySaved,
  };
}

/**
 * Saves a chat answer as a note: a `note` source indexed like any other, so
 * it can be searched and cited later, plus the `notes` row that remembers
 * where it came from. Saving the same message again returns the first note.
 * Indexing is charged to the person saving, like any ingestion; if it fails
 * nothing is left behind.
 */
export async function saveAnswerAsNote(input: {
  workspaceId: string;
  userId: string;
  messageId: string;
}): Promise<SavedAnswerNote> {
  const workspace = await requireContentWorkspace(input);

  const message = await findMessageRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    messageId: input.messageId,
  });
  if (!message || message.role !== "assistant") {
    throw new ContentError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }
  // Reading the message needs the same access as reading its thread.
  await contentThreadService.getThread({
    workspaceId: input.workspaceId,
    threadId: message.threadId,
    userId: input.userId,
  });
  if (!message.content.trim()) {
    throw new ContentError(
      400,
      "MESSAGE_EMPTY",
      "There is no answer text to save",
    );
  }

  const existing = await findSavedNote({
    teamId: workspace.organizationId,
    messageId: message.id,
  });
  if (existing) return toResult(existing, true);

  const citations = readMessageCitations(message.metadata);
  const rewritten = rewriteCitationsForNote({
    content: message.content,
    citations,
  });
  const title = noteTitle(message.content);

  const source = await createSourceRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    title,
    contentText: rewritten.text,
    createdBy: input.userId,
    ingestKind: "note",
    sourceType: "note",
    mimeType: "text/markdown",
  });

  try {
    await sourceIndexingService.indexSource({
      workspaceId: workspace.id,
      sourceId: source.id,
      userId: input.userId,
    });
  } catch (error) {
    await contentSourceService
      .deleteSource({
        workspaceId: workspace.id,
        sourceId: source.id,
        userId: input.userId,
      })
      .catch((cleanupError: unknown) =>
        logger.warn("Could not remove the source of a failed note save", {
          err: cleanupError,
          sourceId: source.id,
        }),
      );
    throw error;
  }

  const noteId = randomUUID();
  const citedSourceIds = [
    ...new Set(
      rewritten.references
        .map((reference) => reference.sourceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  try {
    await db.transaction(async (tx) => {
      await tx.insert(notes).values({
        id: noteId,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: message.threadId,
        sourceMessageId: message.id,
        sourceId: source.id,
        noteType: "saved_response",
        title,
        contentText: rewritten.text,
        contentJson: { references: rewritten.references },
        isEditable: false,
        createdBy: input.userId,
      });
      if (citedSourceIds.length > 0) {
        await tx
          .insert(noteSources)
          .values(citedSourceIds.map((sourceId) => ({ noteId, sourceId })))
          .onConflictDoNothing();
      }
    });
  } catch (error) {
    // A concurrent save of the same message won the unique index: keep its
    // note and drop the duplicate source this call made.
    const winner = await findSavedNote({
      teamId: workspace.organizationId,
      messageId: message.id,
    });
    await contentSourceService
      .deleteSource({
        workspaceId: workspace.id,
        sourceId: source.id,
        userId: input.userId,
      })
      .catch(() => undefined);
    if (winner) return toResult(winner, true);
    throw error;
  }

  return { noteId, sourceId: source.id, title, alreadySaved: false };
}

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { db, messages, threads } from "@sourceweft/db";
import { logger } from "../../shared/logger";
import { publishThreadEvent } from "../../shared/notify-hub";
import type { MessageRecord, MessageRole } from "../content/types";

type MessageRow = typeof messages.$inferSelect;
type MessageInclude = {
  citations: boolean;
  contentJson: boolean;
  metadata: boolean;
};

const fullMessageInclude: MessageInclude = {
  citations: true,
  contentJson: true,
  metadata: true,
};

function trimMetadata(
  metadata: Record<string, unknown>,
  include: MessageInclude,
): Record<string, unknown> {
  if (include.metadata) {
    return metadata;
  }
  const trimmed: Record<string, unknown> = {};
  for (const key of [
    "effectiveMentionedSourceIds",
    "effectiveSourceIds",
    "mentionedSourceIds",
    "sourceIds",
    "turnId",
  ]) {
    if (key in metadata) {
      trimmed[key] = metadata[key];
    }
  }
  if (include.citations && "retrieval" in metadata) {
    trimmed.retrieval = metadata.retrieval;
  }
  return trimmed;
}

function mapMessage(
  row: MessageRow,
  include: MessageInclude = fullMessageInclude,
): MessageRecord {
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
    contentJson: include.contentJson ? row.contentJson ?? {} : {},
    metadata: trimMetadata(row.metadata ?? {}, include),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createMessageRecord(input: {
  id?: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  parentMessageId?: string | null;
  role: MessageRole;
  content: string;
  contentJson?: Record<string, unknown>;
  createdBy?: string | null;
  model?: string | null;
  creditsConsumed?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const id = input.id ?? randomUUID();
  const createdAt = new Date();
  const message = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        id,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        parentMessageId: input.parentMessageId ?? null,
        role: input.role,
        content: input.content,
        contentJson: input.contentJson ?? {},
        createdBy: input.createdBy ?? null,
        model: input.model ?? null,
        creditsConsumed: input.creditsConsumed ?? null,
        metadata: input.metadata ?? {},
        createdAt,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create message");
    }

    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`greatest(coalesce(${threads.lastMessageAt}, ${createdAt}), ${createdAt})`,
        updatedAt: sql`greatest(${threads.updatedAt}, ${createdAt})`,
      })
      .where(
        and(
          eq(threads.id, input.threadId),
          eq(threads.teamId, input.teamId),
          eq(threads.workspaceId, input.workspaceId),
        ),
      );

    return mapMessage(row);
  });

  // Emit AFTER commit (not inside the tx) so a rolled-back insert never signals.
  // Only user messages: the assistant message starts as an empty placeholder and
  // is signaled instead by `run_finished` once the turn is durable.
  if (message.role === "user") {
    void publishThreadEvent({
      threadId: message.threadId,
      workspaceId: message.workspaceId,
      kind: "message_created",
      messageId: message.id,
      role: "user",
      ...(message.createdBy ? { actorUserId: message.createdBy } : {}),
    }).catch((error) => {
      logger.warn("Failed to publish thread message event", {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return message;
}

export async function listMessageRecordsByThread(input: {
  include?: MessageInclude;
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

  return rows.map((row) => mapMessage(row, input.include));
}

function encodeMessageCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    "utf8",
  ).toString("base64url");
}

/**
 * Page a thread's messages. `before` pages backward (older, the default UI
 * pagination); `after` pages forward (strictly newer, ascending) and is what
 * the live-collaboration reconcile-on-connect uses to drain messages missed
 * while the room SSE was down. The `(createdAt, id)` tuple is a stable total
 * order — message `id` is a random UUID and must never be treated as
 * time-sortable on its own. If both cursors are given, `after` wins.
 */
export async function listMessageRecordPageByThread(input: {
  include?: MessageInclude;
  teamId: string;
  workspaceId: string;
  threadId: string;
  before?: { createdAt: Date; id: string } | null;
  after?: { createdAt: Date; id: string } | null;
  limit: number;
}) {
  const forward = Boolean(input.after);
  const cursor = input.after ?? input.before ?? null;

  const conditions = [
    eq(messages.teamId, input.teamId),
    eq(messages.workspaceId, input.workspaceId),
    eq(messages.threadId, input.threadId),
    cursor
      ? forward
        ? or(
            gt(messages.createdAt, cursor.createdAt),
            and(
              eq(messages.createdAt, cursor.createdAt),
              gt(messages.id, cursor.id),
            ),
          )
        : or(
            lt(messages.createdAt, cursor.createdAt),
            and(
              eq(messages.createdAt, cursor.createdAt),
              lt(messages.id, cursor.id),
            ),
          )
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(
      forward ? asc(messages.createdAt) : desc(messages.createdAt),
      forward ? asc(messages.id) : desc(messages.id),
    )
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const nextRow = rows[input.limit] ?? null;

  // Both directions return items in ascending (chronological) order; backward
  // mode fetched descending, so it reverses.
  const orderedRows = forward ? pageRows : pageRows.reverse();

  return {
    items: orderedRows.map((row) => mapMessage(row, input.include)),
    nextCursor: nextRow ? encodeMessageCursor(nextRow) : null,
  };
}

export async function findMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  messageId: string;
}) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.teamId, input.teamId),
        eq(messages.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapMessage(row) : null;
}

export async function updateMessageMetadataRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  metadata: Record<string, unknown>;
}) {
  const [row] = await db
    .update(messages)
    .set({ metadata: input.metadata })
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.teamId, input.teamId),
        eq(messages.workspaceId, input.workspaceId),
        eq(messages.threadId, input.threadId),
      ),
    )
    .returning();

  return row ? mapMessage(row) : null;
}

export async function updateMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  content?: string;
  contentJson?: Record<string, unknown>;
  model?: string | null;
  creditsConsumed?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const set: Partial<typeof messages.$inferInsert> = {};
  if (input.content !== undefined) {
    set.content = input.content;
  }
  if (input.contentJson !== undefined) {
    set.contentJson = input.contentJson;
  }
  if (input.model !== undefined) {
    set.model = input.model;
  }
  if (input.creditsConsumed !== undefined) {
    set.creditsConsumed = input.creditsConsumed;
  }
  if (input.metadata !== undefined) {
    set.metadata = input.metadata;
  }

  if (Object.keys(set).length === 0) {
    return findMessageRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
    });
  }

  const [row] = await db
    .update(messages)
    .set(set)
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.teamId, input.teamId),
        eq(messages.workspaceId, input.workspaceId),
        eq(messages.threadId, input.threadId),
      ),
    )
    .returning();

  return row ? mapMessage(row) : null;
}

export async function deleteMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
}) {
  await db
    .delete(messages)
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.teamId, input.teamId),
        eq(messages.workspaceId, input.workspaceId),
        eq(messages.threadId, input.threadId),
      ),
    );
}


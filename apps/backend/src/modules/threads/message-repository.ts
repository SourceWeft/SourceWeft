import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { db, messages, threads } from "@sourceweft/db";
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
  return db.transaction(async (tx) => {
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

export async function listMessageRecordPageByThread(input: {
  include?: MessageInclude;
  teamId: string;
  workspaceId: string;
  threadId: string;
  before?: { createdAt: Date; id: string } | null;
  limit: number;
}) {
  const conditions = [
    eq(messages.teamId, input.teamId),
    eq(messages.workspaceId, input.workspaceId),
    eq(messages.threadId, input.threadId),
    input.before
      ? or(
          lt(messages.createdAt, input.before.createdAt),
          and(
            eq(messages.createdAt, input.before.createdAt),
            lt(messages.id, input.before.id),
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
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const nextRow = rows[input.limit] ?? null;

  return {
    items: pageRows.reverse().map((row) => mapMessage(row, input.include)),
    nextCursor: nextRow
      ? Buffer.from(
          JSON.stringify({
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.id,
          }),
          "utf8",
        ).toString("base64url")
      : null,
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


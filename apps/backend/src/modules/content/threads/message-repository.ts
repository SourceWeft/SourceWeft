import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import { messages, threads } from "../../../shared/db/schema";
import type { MessageRecord, MessageRole } from "../types";

type MessageRow = typeof messages.$inferSelect;

function mapMessage(row: MessageRow): MessageRecord {
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
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  parentMessageId?: string | null;
  role: MessageRole;
  content: string;
  createdBy?: string | null;
  model?: string | null;
  creditsConsumed?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const id = randomUUID();
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

  return rows.map(mapMessage);
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

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../shared/database";
import { messages, sources, threads } from "../../shared/db/schema";
import type {
  MessageRecord,
  MessageRole,
  SourceRecord,
  SourceStatus,
  ThreadRecord,
} from "./types";

type SourceRow = typeof sources.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    contentText: row.contentText,
    status: row.status,
    estimatedPages: row.estimatedPages,
    parsedTokens: row.parsedTokens,
    createdBy: row.createdBy,
    indexedAt: row.indexedAt ? row.indexedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    title: row.title,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    createdBy: row.createdBy,
    model: row.model,
    creditsConsumed: row.creditsConsumed,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  contentText: string;
  createdBy: string;
  estimatedPages?: number;
  parsedTokens?: number;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(sources)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      contentText: input.contentText,
      status: "created",
      estimatedPages: input.estimatedPages ?? null,
      parsedTokens: input.parsedTokens ?? null,
      createdBy: input.createdBy,
      indexedAt: null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create source");
  }

  return mapSource(row);
}

export async function findSourceRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapSource(row) : null;
}

export async function markSourceIndexed(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
}) {
  const updates: {
    status: SourceStatus;
    indexedAt: Date;
    updatedAt: Date;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  } = {
    status: "indexed",
    indexedAt: new Date(),
    updatedAt: new Date(),
  };

  if (input.estimatedPages !== undefined) {
    updates.estimatedPages = input.estimatedPages;
  }

  if (input.parsedTokens !== undefined) {
    updates.parsedTokens = input.parsedTokens;
  }

  const [row] = await db
    .update(sources)
    .set(updates)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  if (!row) {
    throw new Error("Failed to index source");
  }

  return mapSource(row);
}

export async function createThreadRecord(input: {
  teamId: string;
  workspaceId: string;
  title: string;
  createdBy: string;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(threads)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      title: input.title,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create thread");
  }

  return mapThread(row);
}

export async function findThreadRecord(input: {
  threadId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.teamId, input.teamId),
        eq(threads.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapThread(row) : null;
}

export async function createMessageRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdBy?: string | null;
  model?: string | null;
  creditsConsumed?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(messages)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      createdBy: input.createdBy ?? null,
      model: input.model ?? null,
      creditsConsumed: input.creditsConsumed ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create message");
  }

  return mapMessage(row);
}

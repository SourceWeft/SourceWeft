import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  assistantFeedItems,
  assistantTickets,
  assistantTriggers,
  assistants,
  db,
} from "@sourceweft/db";
import type {
  AssistantTriggerSource,
  AssistantTriggerStatus,
  FeedItemKind,
  TicketStage,
} from "@sourceweft/contracts/assistants";

export type AssistantRow = typeof assistants.$inferSelect;
export type AssistantTicketRow = typeof assistantTickets.$inferSelect;
export type AssistantFeedItemRow = typeof assistantFeedItems.$inferSelect;
export type AssistantTriggerRow = typeof assistantTriggers.$inferSelect;

/** A transaction handed to a `db.transaction` callback. */
export type AssistantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = AssistantTx | typeof db;

/** The violated constraint's name when `error` is a unique violation. */
export function uniqueViolation(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const record = candidate as { code?: string; constraint?: string } | null;
    if (record?.code === "23505") return record.constraint ?? "unique";
  }
  return null;
}

// ── assistants ───────────────────────────────────────────────────────────

/** The one assistant row of a workspace, or null when it was never enabled. */
export async function findAssistantRow(
  input: { workspaceId: string; teamId?: string },
  executor: Executor = db,
  options: { forUpdate?: boolean } = {},
): Promise<AssistantRow | null> {
  const query = executor
    .select()
    .from(assistants)
    .where(
      input.teamId
        ? and(
            eq(assistants.workspaceId, input.workspaceId),
            eq(assistants.teamId, input.teamId),
          )
        : eq(assistants.workspaceId, input.workspaceId),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export async function insertAssistantRow(
  tx: AssistantTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    routerThreadId: string;
    stewardUserId: string;
    createdBy: string;
    now: Date;
  },
): Promise<AssistantRow> {
  const [row] = await tx
    .insert(assistants)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      routerThreadId: input.routerThreadId,
      stewardUserId: input.stewardUserId,
      status: "active",
      statusReason: null,
      version: 1,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

export async function updateAssistantRow(
  tx: AssistantTx,
  id: string,
  values: Partial<typeof assistants.$inferInsert>,
): Promise<AssistantRow> {
  const [row] = await tx
    .update(assistants)
    .set(values)
    .where(eq(assistants.id, id))
    .returning();
  return row!;
}

// ── feed items ───────────────────────────────────────────────────────────

/**
 * One feed item, scoped to its tenant and assistant (every caller already
 * has all three at hand) — a bare id lookup would let an id from another
 * workspace or team match, which tenant isolation never allows.
 */
export async function findFeedItemRow(
  input: { id: string; teamId: string; workspaceId: string; assistantId: string },
  executor: Executor = db,
): Promise<AssistantFeedItemRow | null> {
  const [row] = await executor
    .select()
    .from(assistantFeedItems)
    .where(
      and(
        eq(assistantFeedItems.id, input.id),
        eq(assistantFeedItems.teamId, input.teamId),
        eq(assistantFeedItems.workspaceId, input.workspaceId),
        eq(assistantFeedItems.assistantId, input.assistantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertFeedItemRow(
  tx: AssistantTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    kind: FeedItemKind;
    authorUserId?: string | null;
    text: string;
    triggerId?: string | null;
    ticketId?: string | null;
    replyToItemId?: string | null;
  },
): Promise<AssistantFeedItemRow> {
  const [row] = await tx
    .insert(assistantFeedItems)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      kind: input.kind,
      authorUserId: input.authorUserId ?? null,
      text: input.text,
      triggerId: input.triggerId ?? null,
      ticketId: input.ticketId ?? null,
      replyToItemId: input.replyToItemId ?? null,
    })
    .returning();
  return row!;
}

/**
 * A page of one assistant's feed, newest first. `before` names a feed item
 * already seen; one that is unknown, or belongs to another workspace or
 * team (the lookup is tenant-scoped, see `findFeedItemRow`), is treated as
 * no cursor at all (the newest page) rather than an error or a 404, since
 * either case can only be a stale or foreign link, never a page the caller
 * is owed more of.
 */
export async function listFeedItemRows(input: {
  teamId: string;
  workspaceId: string;
  assistantId: string;
  before?: string;
  limit: number;
}): Promise<AssistantFeedItemRow[]> {
  const beforeRow = input.before
    ? await findFeedItemRow({
        id: input.before,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        assistantId: input.assistantId,
      })
    : null;
  return db
    .select()
    .from(assistantFeedItems)
    .where(
      and(
        eq(assistantFeedItems.assistantId, input.assistantId),
        beforeRow
          ? or(
              lt(assistantFeedItems.createdAt, beforeRow.createdAt),
              and(
                eq(assistantFeedItems.createdAt, beforeRow.createdAt),
                lt(assistantFeedItems.id, beforeRow.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(assistantFeedItems.createdAt), desc(assistantFeedItems.id))
    .limit(input.limit);
}

// ── triggers ─────────────────────────────────────────────────────────────

/** One trigger, scoped to its tenant and assistant — see `findFeedItemRow`. */
export async function findTriggerRow(
  input: { id: string; teamId: string; workspaceId: string; assistantId: string },
  executor: Executor = db,
): Promise<AssistantTriggerRow | null> {
  const [row] = await executor
    .select()
    .from(assistantTriggers)
    .where(
      and(
        eq(assistantTriggers.id, input.id),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        eq(assistantTriggers.assistantId, input.assistantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertTriggerRow(
  tx: AssistantTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    sourceKind: AssistantTriggerSource;
    payerUserId?: string | null;
    authorUserId?: string | null;
    dedupeKey: string;
    text: string;
    ticketId?: string | null;
    routedTicketId?: string | null;
    status: AssistantTriggerStatus;
  },
): Promise<AssistantTriggerRow> {
  const [row] = await tx
    .insert(assistantTriggers)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      sourceKind: input.sourceKind,
      payerUserId: input.payerUserId ?? null,
      authorUserId: input.authorUserId ?? null,
      dedupeKey: input.dedupeKey,
      text: input.text,
      ticketId: input.ticketId ?? null,
      routedTicketId: input.routedTicketId ?? null,
      status: input.status,
    })
    .returning();
  return row!;
}

// ── tickets ──────────────────────────────────────────────────────────────

export async function findTicketRow(
  input: { ticketId: string; assistantId: string },
  executor: Executor = db,
  options: { forUpdate?: boolean } = {},
): Promise<AssistantTicketRow | null> {
  const query = executor
    .select()
    .from(assistantTickets)
    .where(
      and(
        eq(assistantTickets.id, input.ticketId),
        eq(assistantTickets.assistantId, input.assistantId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export async function listTicketRows(input: {
  assistantId: string;
  stage?: TicketStage;
}): Promise<AssistantTicketRow[]> {
  return db
    .select()
    .from(assistantTickets)
    .where(
      input.stage
        ? and(
            eq(assistantTickets.assistantId, input.assistantId),
            eq(assistantTickets.stage, input.stage),
          )
        : eq(assistantTickets.assistantId, input.assistantId),
    )
    .orderBy(desc(assistantTickets.createdAt), desc(assistantTickets.id));
}

export async function endTicketRow(
  executor: Executor,
  input: { ticketId: string; now: Date },
): Promise<AssistantTicketRow> {
  const [row] = await executor
    .update(assistantTickets)
    .set({ stage: "ended", endedAt: input.now, updatedAt: input.now })
    .where(eq(assistantTickets.id, input.ticketId))
    .returning();
  return row!;
}

export async function resetTicketFailuresRow(
  executor: Executor,
  input: { ticketId: string; now: Date },
): Promise<AssistantTicketRow> {
  const [row] = await executor
    .update(assistantTickets)
    .set({ consecutiveFailures: 0, updatedAt: input.now })
    .where(eq(assistantTickets.id, input.ticketId))
    .returning();
  return row!;
}

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  assistantDecisions,
  assistantFeedItems,
  assistantTickets,
  assistantTriggers,
  assistants,
  db,
} from "@sourceweft/db";
import type {
  AssistantDecisionAction,
  AssistantTriggerSource,
  AssistantTriggerStatus,
  FeedItemKind,
  TicketStage,
} from "@sourceweft/contracts/assistants";

export type AssistantRow = typeof assistants.$inferSelect;
export type AssistantTicketRow = typeof assistantTickets.$inferSelect;
export type AssistantFeedItemRow = typeof assistantFeedItems.$inferSelect;
export type AssistantTriggerRow = typeof assistantTriggers.$inferSelect;
export type AssistantDecisionRow = typeof assistantDecisions.$inferSelect;

/** A transaction handed to a `db.transaction` callback. */
export type AssistantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = AssistantTx | typeof db;

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

// ── router: triggers ─────────────────────────────────────────────────────

/**
 * Claims pending triggers into one router batch with a CAS: only rows still
 * `pending_eval` flip to `in_eval` (and get `router_batch_key`); a trigger
 * a concurrent cycle already claimed, or that is no longer pending for any
 * other reason, is silently skipped rather than claimed twice.
 */
export async function claimTriggerRows(
  executor: Executor,
  input: {
    assistantId: string;
    teamId: string;
    workspaceId: string;
    triggerIds: string[];
    batchKey: string;
  },
): Promise<AssistantTriggerRow[]> {
  if (input.triggerIds.length === 0) return [];
  return executor
    .update(assistantTriggers)
    .set({ status: "in_eval", routerBatchKey: input.batchKey })
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        inArray(assistantTriggers.id, input.triggerIds),
        eq(assistantTriggers.status, "pending_eval"),
      ),
    )
    .returning();
}

/**
 * Triggers by id, scoped to tenant and assistant, in any status. Used by the
 * Router tools to resolve and validate a `triggerId` a tool call named
 * (batch membership, current status) before acting on it — never a bare id
 * lookup, which would let an id from another workspace or team match.
 */
export async function findTriggerRowsByIds(
  input: {
    ids: string[];
    teamId: string;
    workspaceId: string;
    assistantId: string;
  },
  executor: Executor = db,
): Promise<AssistantTriggerRow[]> {
  if (input.ids.length === 0) return [];
  return executor
    .select()
    .from(assistantTriggers)
    .where(
      and(
        inArray(assistantTriggers.id, input.ids),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        eq(assistantTriggers.assistantId, input.assistantId),
      ),
    );
}

/**
 * Marks triggers decided: `status` → `decided`, `routed_ticket_id` set to
 * the ticket the decision routed them to (`null` for `ignore`). Scoped to
 * tenant, assistant *and* the batch doing the deciding (`status = 'in_eval'
 * and router_batch_key = routerBatchKey`), so a trigger already decided —
 * by this batch or a stale/duplicate one — is never matched twice: callers
 * compare the returned row count against how many ids they asked for and
 * roll back if they differ (see `router/tools.ts`).
 */
export async function markTriggersDecidedRows(
  executor: Executor,
  input: {
    ids: string[];
    teamId: string;
    workspaceId: string;
    assistantId: string;
    routerBatchKey: string;
    routedTicketId: string | null;
  },
): Promise<AssistantTriggerRow[]> {
  if (input.ids.length === 0) return [];
  return executor
    .update(assistantTriggers)
    .set({ status: "decided", routedTicketId: input.routedTicketId })
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        inArray(assistantTriggers.id, input.ids),
        eq(assistantTriggers.status, "in_eval"),
        eq(assistantTriggers.routerBatchKey, input.routerBatchKey),
      ),
    )
    .returning();
}

/**
 * The triggers still `in_eval` under one router batch: the ones the Router's
 * run ended without deciding (or, read before the Router's turn starts, the
 * batch's own membership — `router/tools.ts`'s `resolveRouterToolsContext`
 * uses this to load `batchTriggerIds` from `batchKey` rather than trust a
 * client-supplied list). `reconcileRouterRun` (router/reconcile.ts`) requeues
 * or expires exactly what this returns.
 */
export async function listInEvalTriggerRows(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  routerBatchKey: string;
}): Promise<AssistantTriggerRow[]> {
  return db
    .select()
    .from(assistantTriggers)
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        eq(assistantTriggers.routerBatchKey, input.routerBatchKey),
        eq(assistantTriggers.status, "in_eval"),
      ),
    );
}

/**
 * Requeues or expires the triggers still `in_eval` under one batch:
 * `eval_attempts` goes up by one and `router_batch_key` is cleared either
 * way. A trigger whose attempts now reach `evalMaxAttempts` becomes
 * `unavailable` (no further retry); the rest go back to `pending_eval`,
 * picked up by the next cycle.
 */
export async function requeueOrExpireInEvalTriggerRows(
  executor: Executor,
  input: {
    assistantId: string;
    teamId: string;
    workspaceId: string;
    routerBatchKey: string;
    evalMaxAttempts: number;
  },
): Promise<AssistantTriggerRow[]> {
  return executor
    .update(assistantTriggers)
    .set({
      evalAttempts: sql`${assistantTriggers.evalAttempts} + 1`,
      status: sql`(case when ${assistantTriggers.evalAttempts} + 1 >= ${input.evalMaxAttempts} then 'unavailable' else 'pending_eval' end)`,
      routerBatchKey: null,
    })
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        eq(assistantTriggers.routerBatchKey, input.routerBatchKey),
        eq(assistantTriggers.status, "in_eval"),
      ),
    )
    .returning();
}

/** Triggers routed to one ticket (by `create_ticket` or `route_to_ticket`),
 * for `recall`'s "what is linked to this ticket" summary. */
export async function findTriggerRowsRoutedToTicket(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  ticketId: string;
  limit: number;
}): Promise<AssistantTriggerRow[]> {
  return db
    .select()
    .from(assistantTriggers)
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        eq(assistantTriggers.routedTicketId, input.ticketId),
      ),
    )
    .orderBy(desc(assistantTriggers.createdAt))
    .limit(input.limit);
}

// ── router: recall (id-prefix lookup) ───────────────────────────────────

export async function findTicketRowsByIdPrefix(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  prefix: string;
  limit: number;
}): Promise<AssistantTicketRow[]> {
  return db
    .select()
    .from(assistantTickets)
    .where(
      and(
        eq(assistantTickets.assistantId, input.assistantId),
        eq(assistantTickets.teamId, input.teamId),
        eq(assistantTickets.workspaceId, input.workspaceId),
        sql`${assistantTickets.id} like ${`${input.prefix}%`}`,
      ),
    )
    .limit(input.limit);
}

export async function findTriggerRowsByIdPrefix(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  prefix: string;
  limit: number;
}): Promise<AssistantTriggerRow[]> {
  return db
    .select()
    .from(assistantTriggers)
    .where(
      and(
        eq(assistantTriggers.assistantId, input.assistantId),
        eq(assistantTriggers.teamId, input.teamId),
        eq(assistantTriggers.workspaceId, input.workspaceId),
        sql`${assistantTriggers.id} like ${`${input.prefix}%`}`,
      ),
    )
    .limit(input.limit);
}

export async function findFeedItemRowsByIdPrefix(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  prefix: string;
  limit: number;
}): Promise<AssistantFeedItemRow[]> {
  return db
    .select()
    .from(assistantFeedItems)
    .where(
      and(
        eq(assistantFeedItems.assistantId, input.assistantId),
        eq(assistantFeedItems.teamId, input.teamId),
        eq(assistantFeedItems.workspaceId, input.workspaceId),
        sql`${assistantFeedItems.id} like ${`${input.prefix}%`}`,
      ),
    )
    .limit(input.limit);
}

// ── router: decisions ────────────────────────────────────────────────────

export async function insertDecisionRow(
  tx: AssistantTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    triggerId: string;
    routerBatchKey: string;
    action: AssistantDecisionAction;
    ticketId?: string | null;
    reason?: string | null;
  },
): Promise<AssistantDecisionRow> {
  const [row] = await tx
    .insert(assistantDecisions)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      triggerId: input.triggerId,
      routerBatchKey: input.routerBatchKey,
      action: input.action,
      ticketId: input.ticketId ?? null,
      reason: input.reason ?? null,
    })
    .returning();
  return row!;
}

// ── tickets ──────────────────────────────────────────────────────────────

/**
 * Inserts a new, router-created ticket. P1 fixes `origin` at its default
 * (`explicit`, see `packages/db/src/schema/assistants.ts`) even for a
 * Router-inferred ticket; the column keeps the full vocabulary so an actual
 * `inferred` ticket needs no migration later.
 */
export async function insertTicketRow(
  tx: AssistantTx,
  input: {
    id: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    workerThreadId: string;
    title: string;
    goal: string;
    payerUserId: string;
    creditCap: number;
    now: Date;
  },
): Promise<AssistantTicketRow> {
  const [row] = await tx
    .insert(assistantTickets)
    .values({
      id: input.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      workerThreadId: input.workerThreadId,
      title: input.title,
      goal: input.goal,
      payerUserId: input.payerUserId,
      creditCap: String(input.creditCap),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

/**
 * Candidate tickets for one batch's "related tickets" render context, in
 * the spec's order: the batch's own payer first, then a ticket that has
 * ever been a `route_to_ticket` target, then most recently updated — each
 * tier newest-first. Callers slice to `ASSISTANT_LIMITS.relatedTicketsMax`
 * (render.ts's `renderBatch` also defends this bound on its own input).
 */
export async function listRelatedTicketCandidateRows(input: {
  assistantId: string;
  teamId: string;
  workspaceId: string;
  payerUserId: string;
  limit: number;
}): Promise<AssistantTicketRow[]> {
  const samePayer = sql`(${assistantTickets.payerUserId} = ${input.payerUserId})`;
  const wasRouted = sql`exists (
    select 1 from ${assistantDecisions}
    where ${assistantDecisions.ticketId} = ${assistantTickets.id}
      and ${assistantDecisions.action} = 'route_to_ticket'
      and ${assistantDecisions.teamId} = ${input.teamId}
      and ${assistantDecisions.workspaceId} = ${input.workspaceId}
  )`;
  return db
    .select()
    .from(assistantTickets)
    .where(
      and(
        eq(assistantTickets.assistantId, input.assistantId),
        eq(assistantTickets.teamId, input.teamId),
        eq(assistantTickets.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(samePayer), desc(wasRouted), desc(assistantTickets.updatedAt))
    .limit(input.limit);
}

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

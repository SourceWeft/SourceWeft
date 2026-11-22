import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("assistants");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

/** The violated constraint's name, or null when the statement went through. */
async function violation(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string; code?: string } })
      .cause;
    return cause?.constraint ?? cause?.code ?? "error";
  }
}

type Tenant = { teamId: string; workspaceId: string };

async function workspace(): Promise<Tenant> {
  const teamId: string = randomUUID();
  const workspaceId: string = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Assistants",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

async function assistant(
  tenant: Tenant,
  overrides: Partial<typeof schema.assistants.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    ...tenant,
    routerThreadId: randomUUID(),
    stewardUserId: "steward-1",
    ...overrides,
  };
  await schema.db.insert(schema.assistants).values(row);
  return row;
}

async function trigger(
  owner: Awaited<ReturnType<typeof assistant>>,
  overrides: Partial<typeof schema.assistantTriggers.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    teamId: owner.teamId,
    workspaceId: owner.workspaceId,
    assistantId: owner.id,
    sourceKind: "member_message" as const,
    dedupeKey: randomUUID(),
    text: "Please check the invoice totals",
    ...overrides,
  };
  await schema.db.insert(schema.assistantTriggers).values(row);
  return row;
}

async function decision(
  owner: Awaited<ReturnType<typeof assistant>>,
  triggerRow: Awaited<ReturnType<typeof trigger>>,
  overrides: Partial<typeof schema.assistantDecisions.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    teamId: owner.teamId,
    workspaceId: owner.workspaceId,
    assistantId: owner.id,
    triggerId: triggerRow.id,
    routerBatchKey: randomUUID(),
    action: "create_ticket" as const,
    ...overrides,
  };
  await schema.db.insert(schema.assistantDecisions).values(row);
  return row;
}

async function ticket(
  owner: Awaited<ReturnType<typeof assistant>>,
  overrides: Partial<typeof schema.assistantTickets.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    teamId: owner.teamId,
    workspaceId: owner.workspaceId,
    assistantId: owner.id,
    workerThreadId: randomUUID(),
    title: "Reconcile November invoices",
    goal: "Match invoices against the bank statement",
    payerUserId: "payer-1",
    creditCap: "500",
    ...overrides,
  };
  await schema.db.insert(schema.assistantTickets).values(row);
  return row;
}

async function feedItem(
  owner: Awaited<ReturnType<typeof assistant>>,
  overrides: Partial<typeof schema.assistantFeedItems.$inferInsert> = {},
) {
  const row = {
    id: randomUUID() as string,
    teamId: owner.teamId,
    workspaceId: owner.workspaceId,
    assistantId: owner.id,
    kind: "member_message" as const,
    text: "Please check the invoice totals",
    ...overrides,
  };
  await schema.db.insert(schema.assistantFeedItems).values(row);
  return row;
}

async function thread(tenant: Tenant, origin: string) {
  const id = randomUUID();
  await schema.db.insert(schema.threads).values({
    id,
    ...tenant,
    title: "Run",
    origin: origin as never,
    createdBy: "owner-1",
  });
  return id;
}

test("an assistant defaults to active with version 1 and no router run in flight", async () => {
  const tenant = await workspace();
  const created = await assistant(tenant);
  const [row] = await schema.db
    .select()
    .from(schema.assistants)
    .where(eq(schema.assistants.id, created.id));
  assert.ok(row);
  assert.equal(row.status, "active");
  assert.equal(row.statusReason, null);
  assert.equal(row.version, 1);
  assert.equal(row.currentRouterRunId, null);
  assert.equal(row.currentRouterBatchKey, null);
  assert.ok(row.createdAt instanceof Date);
});

test("an assistant must live in a workspace of its own team", async () => {
  const tenant = await workspace();
  const other = await workspace();
  assert.equal(
    await violation(() => assistant({ ...tenant, teamId: other.teamId })),
    "assistants_workspace_team_fk",
  );
  assert.equal(
    await violation(() =>
      assistant({ teamId: tenant.teamId, workspaceId: "nope" }),
    ),
    "assistants_workspace_team_fk",
  );
});

test("a second assistant in the same workspace violates the one-per-workspace unique constraint", async () => {
  const tenant = await workspace();
  await assistant(tenant);
  assert.equal(
    await violation(() => assistant(tenant)),
    "assistants_workspace_uq",
  );
  // Another workspace may have its own.
  const other = await workspace();
  await assistant(other);
});

test("assistant columns only accept the documented vocabulary and bounds", async () => {
  // Assistants are one per workspace, so every attempt gets its own.
  const attempt = (overrides: Parameters<typeof assistant>[1]) =>
    violation(async () => assistant(await workspace(), overrides));
  assert.equal(
    await attempt({ status: "ended" as never }),
    "assistants_status_check",
  );
  assert.equal(
    await attempt({ statusReason: "quit" as never }),
    "assistants_status_reason_check",
  );
  assert.equal(await attempt({ version: 0 }), "assistants_version_check");
  for (const status of ["active", "paused"] as const)
    assert.equal(await attempt({ status }), null);
  for (const statusReason of ["steward_left", "by_admin"] as const)
    assert.equal(
      await attempt({ status: "paused", statusReason }),
      null,
    );
});

test("a trigger defaults to pending_eval with zero eval attempts", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const created = await trigger(owner);
  const [row] = await schema.db
    .select()
    .from(schema.assistantTriggers)
    .where(eq(schema.assistantTriggers.id, created.id));
  assert.ok(row);
  assert.equal(row.status, "pending_eval");
  assert.equal(row.evalAttempts, 0);
  assert.equal(row.ticketId, null);
  assert.equal(row.routedTicketId, null);
  assert.equal(row.deliveredAt, null);
});

test("a repeated dedupe key on the same assistant violates the unique constraint", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const first = await trigger(owner, { dedupeKey: "dup-1" });
  assert.equal(
    await violation(() => trigger(owner, { dedupeKey: "dup-1" })),
    "assistant_triggers_assistant_dedupe_uq",
  );
  // A different assistant may reuse the same dedupe key.
  const otherOwner = await assistant(await workspace());
  await trigger(otherOwner, { dedupeKey: "dup-1" });
  assert.ok(first.id);
});

test("trigger columns only accept the documented vocabulary and bounds", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const attempt = (overrides: Parameters<typeof trigger>[1]) =>
    violation(() => trigger(owner, overrides));
  assert.equal(
    await attempt({ sourceKind: "admin_console" as never }),
    "assistant_triggers_source_kind_check",
  );
  assert.equal(
    await attempt({ status: "cancelled" as never }),
    "assistant_triggers_status_check",
  );
  assert.equal(
    await attempt({ text: "x".repeat(4001) }),
    "assistant_triggers_text_length_check",
  );
  assert.equal(
    await attempt({ evalAttempts: -1 }),
    "assistant_triggers_eval_attempts_check",
  );
  assert.equal(await attempt({ text: "x".repeat(4000) }), null);
  for (const sourceKind of ["member_message", "worker_report"] as const)
    assert.equal(await attempt({ sourceKind, dedupeKey: randomUUID() }), null);
});

test("a decision's action is limited to the documented vocabulary", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const triggerRow = await trigger(owner);
  assert.equal(
    await violation(() =>
      decision(owner, triggerRow, { action: "escalate" as never }),
    ),
    "assistant_decisions_action_check",
  );
  for (const action of [
    "create_ticket",
    "route_to_ticket",
    "ignore",
  ] as const)
    assert.equal(
      await violation(() =>
        decision(owner, triggerRow, {
          action,
          routerBatchKey: randomUUID(),
        }),
      ),
      null,
    );
});

test("a trigger may have only one decision per router batch", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const triggerRow = await trigger(owner);
  const batchKey = randomUUID();
  await decision(owner, triggerRow, { routerBatchKey: batchKey });
  assert.equal(
    await violation(() => decision(owner, triggerRow, { routerBatchKey: batchKey })),
    "assistant_decisions_trigger_batch_uq",
  );
  // A different batch for the same trigger is fine.
  await decision(owner, triggerRow, { routerBatchKey: randomUUID() });
});

test("a ticket defaults to an explicit, queued origin with zero consecutive failures", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const created = await ticket(owner);
  const [row] = await schema.db
    .select()
    .from(schema.assistantTickets)
    .where(eq(schema.assistantTickets.id, created.id));
  assert.ok(row);
  assert.equal(row.origin, "explicit");
  assert.equal(row.stage, "queued");
  assert.equal(row.outcome, null);
  assert.equal(row.blockedReason, null);
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.endedAt, null);
});

test("ticket columns only accept the documented vocabulary and bounds", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const attempt = (overrides: Parameters<typeof ticket>[1]) =>
    violation(() => ticket(owner, overrides));
  assert.equal(
    await attempt({ origin: "automatic" as never }),
    "assistant_tickets_origin_check",
  );
  assert.equal(
    await attempt({ stage: "cancelled" as never }),
    "assistant_tickets_stage_check",
  );
  assert.equal(
    await attempt({ outcome: "succeeded" as never }),
    "assistant_tickets_outcome_check",
  );
  assert.equal(
    await attempt({ blockedReason: "unknown" as never }),
    "assistant_tickets_blocked_reason_check",
  );
  assert.equal(
    await attempt({ creditCap: "-1" }),
    "assistant_tickets_credit_cap_check",
  );
  assert.equal(
    await attempt({ consecutiveFailures: -1 }),
    "assistant_tickets_consecutive_failures_check",
  );
  for (const stage of [
    "queued",
    "working",
    "waiting_person",
    "idle",
    "ended",
  ] as const)
    assert.equal(await attempt({ stage }), null);
  for (const outcome of [
    "ready",
    "dropped",
    "failed",
    "blocked",
    "waiting",
  ] as const)
    assert.equal(await attempt({ stage: "ended", outcome }), null);
  for (const blockedReason of [
    "credit_cap",
    "insufficient_credits",
    "repeated_failure",
  ] as const)
    assert.equal(
      await attempt({ stage: "ended", outcome: "blocked", blockedReason }),
      null,
    );
});

test("a feed item defaults with no author or reply and the kind vocabulary is closed", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const created = await feedItem(owner);
  const [row] = await schema.db
    .select()
    .from(schema.assistantFeedItems)
    .where(eq(schema.assistantFeedItems.id, created.id));
  assert.ok(row);
  assert.equal(row.authorUserId, null);
  assert.equal(row.triggerId, null);
  assert.equal(row.ticketId, null);
  assert.equal(row.replyToItemId, null);

  assert.equal(
    await violation(() => feedItem(owner, { kind: "ping" as never })),
    "assistant_feed_items_kind_check",
  );
  assert.equal(
    await violation(() => feedItem(owner, { text: "x".repeat(4001) })),
    "assistant_feed_items_text_length_check",
  );
  for (const kind of [
    "member_message",
    "router_message",
    "ticket_update",
  ] as const)
    assert.equal(await violation(() => feedItem(owner, { kind })), null);

  const reply = await feedItem(owner, { replyToItemId: created.id });
  await schema.db
    .delete(schema.assistantFeedItems)
    .where(eq(schema.assistantFeedItems.id, created.id));
  const [keptReply] = await schema.db
    .select()
    .from(schema.assistantFeedItems)
    .where(eq(schema.assistantFeedItems.id, reply.id));
  assert.ok(keptReply);
  assert.equal(keptReply.replyToItemId, null);
});

test("deleting an assistant cascades to its triggers, decisions, tickets and feed items", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const triggerRow = await trigger(owner);
  await decision(owner, triggerRow);
  await ticket(owner);
  await feedItem(owner);

  await schema.db
    .delete(schema.assistants)
    .where(eq(schema.assistants.id, owner.id));

  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantTriggers)
        .where(eq(schema.assistantTriggers.assistantId, owner.id))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantDecisions)
        .where(eq(schema.assistantDecisions.assistantId, owner.id))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantTickets)
        .where(eq(schema.assistantTickets.assistantId, owner.id))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantFeedItems)
        .where(eq(schema.assistantFeedItems.assistantId, owner.id))
    ).length,
    0,
  );
});

test("threads accept the two new assistant origins and reject anything else", async () => {
  const tenant = await workspace();
  await thread(tenant, "assistant_router");
  await thread(tenant, "assistant_ticket");
  assert.equal(
    await violation(() => thread(tenant, "bogus")),
    "threads_origin_check",
  );
});

test("a chat thread run may record its consumed credits, non-negative, with no default", async () => {
  const tenant = await workspace();
  const threadId = await thread(tenant, "assistant_ticket");
  const runId = randomUUID();
  await schema.db.insert(schema.chatThreadRuns).values({
    id: runId,
    ...tenant,
    threadId,
    userId: "owner-1",
    idempotencyKey: runId,
    mode: "send",
    streamKey: runId,
  });
  const [withoutValue] = await schema.db
    .select()
    .from(schema.chatThreadRuns)
    .where(eq(schema.chatThreadRuns.id, runId));
  assert.equal(withoutValue!.consumedCredits, null);

  await schema.db
    .update(schema.chatThreadRuns)
    .set({ consumedCredits: "12.5" })
    .where(eq(schema.chatThreadRuns.id, runId));
  const [withValue] = await schema.db
    .select()
    .from(schema.chatThreadRuns)
    .where(eq(schema.chatThreadRuns.id, runId));
  assert.equal(withValue!.consumedCredits, "12.5");

  assert.equal(
    await violation(() =>
      schema.db
        .update(schema.chatThreadRuns)
        .set({ consumedCredits: "-1" })
        .where(eq(schema.chatThreadRuns.id, runId)),
    ),
    "chat_thread_runs_consumed_credits_check",
  );
});

test("deleting a workspace cascades through all five assistant tables", async () => {
  const tenant = await workspace();
  const owner = await assistant(tenant);
  const triggerRow = await trigger(owner);
  await decision(owner, triggerRow);
  await ticket(owner);
  await feedItem(owner);

  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, tenant.workspaceId));

  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistants)
        .where(eq(schema.assistants.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantTriggers)
        .where(eq(schema.assistantTriggers.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantDecisions)
        .where(eq(schema.assistantDecisions.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantTickets)
        .where(eq(schema.assistantTickets.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.assistantFeedItems)
        .where(eq(schema.assistantFeedItems.workspaceId, tenant.workspaceId))
    ).length,
    0,
  );
});

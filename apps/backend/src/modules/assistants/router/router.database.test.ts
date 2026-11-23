import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAssistantFixture,
  type AssistantFixture,
} from "../../../test/assistant-fixture";
import { ASSISTANT_LIMITS } from "../limits";
import type { claimBatch, routerBatchKey } from "./batch";
import type { reconcileRouterRun } from "./reconcile";
import type {
  createRouterTools,
  isRouterToolError,
  resolveRouterToolsContext,
  RouterToolsContext,
} from "./tools";

let f: AssistantFixture;
// `./batch`, `./tools` and `./reconcile` all import `db` from
// `@sourceweft/db`, whose connection pool is created once, eagerly, at
// first import — exactly like `modules/assistants/service.ts`. A static
// top-level import of them would therefore bind to whatever `DATABASE_URL`
// is ambient when this test *file* loads (the real dev database), before
// `createAssistantFixture` ever gets to repoint it at this test's isolated
// clone. Importing them dynamically, after the fixture exists, is what
// keeps this test on its own database (see `assistant-fixture.ts`'s own
// header comment for the same reasoning).
let claimBatchFn: typeof claimBatch;
let routerBatchKeyFn: typeof routerBatchKey;
let reconcileRouterRunFn: typeof reconcileRouterRun;
let createRouterToolsFn: typeof createRouterTools;
let isRouterToolErrorFn: typeof isRouterToolError;
let resolveRouterToolsContextFn: typeof resolveRouterToolsContext;

beforeAll(async () => {
  f = await createAssistantFixture("assistant_router");
  const batch = await import("./batch");
  const tools = await import("./tools");
  const reconcile = await import("./reconcile");
  claimBatchFn = batch.claimBatch;
  routerBatchKeyFn = batch.routerBatchKey;
  reconcileRouterRunFn = reconcile.reconcileRouterRun;
  createRouterToolsFn = tools.createRouterTools;
  isRouterToolErrorFn = tools.isRouterToolError;
  resolveRouterToolsContextFn = tools.resolveRouterToolsContext;
}, 120_000);

beforeEach(() => f.reset());

afterAll(async () => {
  await f?.close();
});

/** A fresh team workspace with its assistant enabled, a steward, and one
 * ordinary member who will pay for everything this test does. */
async function setupAssistant() {
  const steward = randomUUID();
  const member = randomUUID();
  const { teamId, workspaceId } = await f.workspace(
    [
      [steward, "owner"],
      [member, "member"],
    ],
    { kind: "team" },
  );
  const assistant = await f.service.enable({ workspaceId, userId: steward });
  return { steward, member, teamId, workspaceId, assistant };
}

function routerCtx(input: {
  teamId: string;
  workspaceId: string;
  assistantId: string;
  batchKey: string;
  batchTriggerIds: string[];
}): RouterToolsContext {
  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    threadId: randomUUID(),
    runId: randomUUID(),
    userId: input.assistantId,
    hostContext: {},
    assistantId: input.assistantId,
    batchKey: input.batchKey,
    batchTriggerIds: input.batchTriggerIds,
  };
}

// ── create_ticket ────────────────────────────────────────────────────────

test("create_ticket writes the ticket, one decision per trigger, and one feed item, and decides every trigger — atomically", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    sourceKind: "member_message",
    text: "Please help with the thing",
  });
  const t2 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    sourceKind: "member_message",
    text: "Also this",
  });
  const batchKey = routerBatchKeyFn([t1.id, t2.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id, t2.id] },
    batchKey,
    { teamId, workspaceId },
  );

  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id, t2.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const createTicket = tools.find((tool) => tool.name === "create_ticket")!;

  const result = (await createTicket.invoke({
    title: "Help request",
    goal: "Do the thing the member asked for",
    triggerIds: [t1.id, t2.id],
  })) as { ticketId: string };
  assert.ok(!isRouterToolErrorFn(result));
  assert.ok(result.ticketId);

  const decisions = await f.decisionRows(assistant.id);
  assert.equal(decisions.length, 2);
  assert.ok(
    decisions.every(
      (row) =>
        row.action === "create_ticket" && row.ticketId === result.ticketId,
    ),
  );

  const feed = await f.feedItemRows(assistant.id);
  assert.equal(
    feed.filter(
      (item) =>
        item.kind === "ticket_update" && item.ticketId === result.ticketId,
    ).length,
    1,
  );

  const trig1 = await f.triggerRow(t1.id);
  const trig2 = await f.triggerRow(t2.id);
  assert.equal(trig1!.status, "decided");
  assert.equal(trig1!.routedTicketId, result.ticketId);
  assert.equal(trig2!.status, "decided");
  assert.equal(trig2!.routedTicketId, result.ticketId);
});

test("create_ticket with a triggerId outside the batch returns a tool error and writes nothing", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const inBatch = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    status: "in_eval",
  });
  // Pending, but never claimed into this batch.
  const outside = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const batchKey = routerBatchKeyFn([inBatch.id]);
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [inBatch.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const createTicket = tools.find((tool) => tool.name === "create_ticket")!;

  const result = await createTicket.invoke({
    title: "Help",
    goal: "Do it",
    triggerIds: [inBatch.id, outside.id],
  });
  assert.ok(isRouterToolErrorFn(result));

  assert.equal((await f.decisionRows(assistant.id)).length, 0);
  assert.equal((await f.triggerRow(inBatch.id))!.status, "in_eval");
  assert.equal((await f.triggerRow(outside.id))!.status, "pending_eval");
});

test("route_to_ticket to another assistant's ticket returns a tool error, not a write", async () => {
  const mine = await setupAssistant();
  const other = await setupAssistant();
  const foreignTicket = await f.insertTicket({
    teamId: other.teamId,
    workspaceId: other.workspaceId,
    assistantId: other.assistant.id,
    payerUserId: other.member,
  });

  const t1 = await f.insertTrigger({
    teamId: mine.teamId,
    workspaceId: mine.workspaceId,
    assistantId: mine.assistant.id,
    payerUserId: mine.member,
    status: "in_eval",
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  const ctx = routerCtx({
    teamId: mine.teamId,
    workspaceId: mine.workspaceId,
    assistantId: mine.assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const routeToTicket = tools.find((tool) => tool.name === "route_to_ticket")!;

  const result = await routeToTicket.invoke({
    ticketId: foreignTicket.id,
    triggerIds: [t1.id],
  });
  assert.ok(isRouterToolErrorFn(result));
  assert.equal((await f.triggerRow(t1.id))!.status, "in_eval");
  assert.equal((await f.decisionRows(mine.assistant.id)).length, 0);
});

test("route_to_ticket on an owned ticket writes one decision per trigger and routes them", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id] },
    batchKey,
    { teamId, workspaceId },
  );
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const routeToTicket = tools.find((tool) => tool.name === "route_to_ticket")!;

  const result = (await routeToTicket.invoke({
    ticketId: ticket.id,
    triggerIds: [t1.id],
    note: "Follow-up from the member.",
  })) as { ticketId: string };
  assert.ok(!isRouterToolErrorFn(result));
  assert.equal(result.ticketId, ticket.id);

  const trig = await f.triggerRow(t1.id);
  assert.equal(trig!.status, "decided");
  assert.equal(trig!.routedTicketId, ticket.id);

  const decisions = await f.decisionRows(assistant.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.action, "route_to_ticket");
  assert.equal(decisions[0]!.ticketId, ticket.id);
});

// ── ignore ───────────────────────────────────────────────────────────────

test("ignore writes one decision per trigger with the given reason and decides them", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id] },
    batchKey,
    { teamId, workspaceId },
  );
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const ignore = tools.find((tool) => tool.name === "ignore")!;

  const result = await ignore.invoke({
    triggerIds: [t1.id],
    reason: "Not actionable",
  });
  assert.ok(!isRouterToolErrorFn(result));

  const trig = await f.triggerRow(t1.id);
  assert.equal(trig!.status, "decided");
  assert.equal(trig!.routedTicketId, null);

  const decisions = await f.decisionRows(assistant.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.action, "ignore");
  assert.equal(decisions[0]!.reason, "Not actionable");
});

// ── say ──────────────────────────────────────────────────────────────────

test("say with replyToTriggerId notifies the member message's author (no email)", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    authorUserId: member,
    sourceKind: "member_message",
    status: "in_eval",
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const say = tools.find((tool) => tool.name === "say")!;

  const result = await say.invoke({ text: "On it.", replyToTriggerId: t1.id });
  assert.ok(!isRouterToolErrorFn(result));

  const feed = await f.feedItemRows(assistant.id);
  const said = feed.find((item) => item.kind === "router_message");
  assert.ok(said);
  assert.equal(said!.triggerId, t1.id);

  const replies = f.notifications.filter((n) => n.kind === "assistant_reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.userId, member);
  assert.equal(replies[0]!.email, false);
});

test("say replying to a worker_report trigger writes the feed item but notifies nobody", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    sourceKind: "worker_report",
    status: "in_eval",
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const say = tools.find((tool) => tool.name === "say")!;

  const result = await say.invoke({ text: "Noted.", replyToTriggerId: t1.id });
  assert.ok(!isRouterToolErrorFn(result));
  assert.equal(f.notifications.length, 0);
});

test("say with a replyToTriggerId outside the batch returns a tool error", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const outside = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey: "batch-key",
    batchTriggerIds: [],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const say = tools.find((tool) => tool.name === "say")!;

  const result = await say.invoke({
    text: "Hello",
    replyToTriggerId: outside.id,
  });
  assert.ok(isRouterToolErrorFn(result));
});

// ── recall ───────────────────────────────────────────────────────────────

test("recall finds a ticket by id prefix and returns its full text plus routed triggers", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const batchKey = routerBatchKeyFn([t1.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id] },
    batchKey,
    { teamId, workspaceId },
  );
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const createTicket = tools.find((tool) => tool.name === "create_ticket")!;
  const { ticketId } = (await createTicket.invoke({
    title: "Help request",
    goal: "Help the member",
    triggerIds: [t1.id],
  })) as { ticketId: string };

  const recall = tools.find((tool) => tool.name === "recall")!;
  const result = (await recall.invoke({ id: ticketId.slice(0, 8) })) as {
    kind: string;
    id: string;
    text: string;
    related: Array<{ id: string }>;
  };
  assert.equal(result.kind, "ticket");
  assert.equal(result.id, ticketId);
  assert.match(result.text, /Help request/);
  assert.ok(result.related.some((r) => r.id === t1.id));
});

test("recall returns a tool error for an id that matches nothing", async () => {
  const { teamId, workspaceId, assistant } = await setupAssistant();
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey: "batch-key",
    batchTriggerIds: [],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const recall = tools.find((tool) => tool.name === "recall")!;

  const result = await recall.invoke({ id: "does-not-exist-anywhere" });
  assert.ok(isRouterToolErrorFn(result));
});

// ── reconcileRouterRun: decision completeness ────────────────────────────

test("triggers left in_eval are requeued with eval_attempts += 1, then marked unavailable after evalMaxAttempts with exactly one steward notification", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const t2 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const t3 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });

  // Cycle 1: claim all three, decide only t1 (`ignore`), leave t2/t3 in_eval.
  let batchKey = routerBatchKeyFn([t1.id, t2.id, t3.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id, t2.id, t3.id] },
    batchKey,
    { teamId, workspaceId },
  );
  let runId = randomUUID();
  await f.setCurrentRouterRun(assistant.id, { runId, batchKey });
  const ctx = routerCtx({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    batchKey,
    batchTriggerIds: [t1.id, t2.id, t3.id],
  });
  const tools = createRouterToolsFn(ctx, f.ports);
  const ignore = tools.find((tool) => tool.name === "ignore")!;
  await ignore.invoke({ triggerIds: [t1.id], reason: "not actionable" });

  let assistantNow = (await f.assistantRow(workspaceId))!;
  let result = await reconcileRouterRunFn(assistantNow, { id: runId }, f.ports);
  assert.equal(result.requeued, 2);
  assert.equal(result.unavailable, 0);
  assert.equal((await f.triggerRow(t1.id))!.status, "decided");
  for (const id of [t2.id, t3.id]) {
    const row = await f.triggerRow(id);
    assert.equal(row!.status, "pending_eval");
    assert.equal(row!.evalAttempts, 1);
    assert.equal(row!.routerBatchKey, null);
  }
  assistantNow = (await f.assistantRow(workspaceId))!;
  assert.equal(assistantNow.currentRouterRunId, null);
  assert.equal(assistantNow.currentRouterBatchKey, null);
  assert.equal(f.notifications.length, 0);

  // Cycles 2 and 3: t2/t3 get claimed again and decided by nobody.
  for (let cycle = 0; cycle < 2; cycle++) {
    batchKey = routerBatchKeyFn([t2.id, t3.id]);
    await claimBatchFn(
      assistant.id,
      { payerUserId: member, triggerIds: [t2.id, t3.id] },
      batchKey,
      { teamId, workspaceId },
    );
    runId = randomUUID();
    await f.setCurrentRouterRun(assistant.id, { runId, batchKey });
    assistantNow = (await f.assistantRow(workspaceId))!;
    result = await reconcileRouterRunFn(assistantNow, { id: runId }, f.ports);
  }

  assert.equal(result.requeued, 0);
  assert.equal(result.unavailable, 2);
  for (const id of [t2.id, t3.id]) {
    const row = await f.triggerRow(id);
    assert.equal(row!.status, "unavailable");
    assert.equal(row!.evalAttempts, ASSISTANT_LIMITS.evalMaxAttempts);
  }

  const unavailableNotifications = f.notifications.filter(
    (n) => n.kind === "assistant_unavailable",
  );
  assert.equal(unavailableNotifications.length, 1);
  assert.equal(unavailableNotifications[0]!.userId, assistant.stewardUserId);
  assert.equal(unavailableNotifications[0]!.email, true);
});

test("reconcileRouterRun is a no-op for a run that is not the assistant's current one", async () => {
  const { workspaceId } = await setupAssistant();
  const assistantRow = (await f.assistantRow(workspaceId))!;
  const result = await reconcileRouterRunFn(
    assistantRow,
    { id: randomUUID() },
    f.ports,
  );
  assert.deepEqual(result, { requeued: 0, unavailable: 0 });
  assert.equal(f.notifications.length, 0);
});

test("a delayed reconcile for a stale run never clears a newer run's bookkeeping or touches its triggers", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    status: "in_eval",
  });
  const run1BatchKey = routerBatchKeyFn([t1.id]);
  const run1Id = randomUUID();
  await f.setCurrentRouterRun(assistant.id, {
    runId: run1Id,
    batchKey: run1BatchKey,
  });
  // The caller captured this snapshot while run1 was still current...
  const staleSnapshot = (await f.assistantRow(workspaceId))!;
  assert.equal(staleSnapshot.currentRouterRunId, run1Id);

  // ...but by the time it calls reconcile, run2 has already started (t1 is
  // still in_eval under run1's batch key — run1's own reconcile just never
  // happened yet, or got delayed past run2's start).
  const t2 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    status: "in_eval",
  });
  const run2BatchKey = routerBatchKeyFn([t2.id]);
  const run2Id = randomUUID();
  await f.setCurrentRouterRun(assistant.id, {
    runId: run2Id,
    batchKey: run2BatchKey,
  });

  // The delayed call still names run1 and carries the stale snapshot.
  const result = await reconcileRouterRunFn(
    staleSnapshot,
    { id: run1Id },
    f.ports,
  );
  assert.deepEqual(result, { requeued: 0, unavailable: 0 });

  // run2's bookkeeping is untouched.
  const assistantAfter = (await f.assistantRow(workspaceId))!;
  assert.equal(assistantAfter.currentRouterRunId, run2Id);
  assert.equal(assistantAfter.currentRouterBatchKey, run2BatchKey);
  // Neither trigger was touched by the stale call.
  assert.equal((await f.triggerRow(t1.id))!.status, "in_eval");
  assert.equal((await f.triggerRow(t1.id))!.evalAttempts, 0);
  assert.equal((await f.triggerRow(t2.id))!.status, "in_eval");
  assert.equal(f.notifications.length, 0);
});

// ── resolveRouterToolsContext ────────────────────────────────────────────

test("resolveRouterToolsContext throws when hostContext is missing assistantId or batchKey", async () => {
  await assert.rejects(() =>
    resolveRouterToolsContextFn({
      workspaceId: randomUUID(),
      teamId: randomUUID(),
      threadId: randomUUID(),
      runId: randomUUID(),
      userId: randomUUID(),
      hostContext: {},
    }),
  );
});

test("resolveRouterToolsContext throws when the assistant does not exist in this workspace", async () => {
  const { workspaceId, teamId } = await f.workspace([], { kind: "team" });
  await assert.rejects(() =>
    resolveRouterToolsContextFn({
      workspaceId,
      teamId,
      threadId: randomUUID(),
      runId: randomUUID(),
      userId: randomUUID(),
      hostContext: {
        assistantId: randomUUID(),
        batchKey: "key",
      },
    }),
  );
});

test("resolveRouterToolsContext throws when no in_eval triggers exist for the given batchKey — a turn-setup failure, not an upstream model error", async () => {
  const { teamId, workspaceId, assistant } = await setupAssistant();
  const { toObservationError } =
    await import("../../threads/stream/observability");
  await assert.rejects(
    () =>
      resolveRouterToolsContextFn({
        workspaceId,
        teamId,
        threadId: randomUUID(),
        runId: randomUUID(),
        userId: randomUUID(),
        hostContext: {
          assistantId: assistant.id,
          batchKey: "a-batch-key-nothing-is-claimed-under",
        },
      }),
    (error: unknown) => {
      assert.match(
        String((error as Error).message),
        /No in_eval triggers found for batch/,
      );
      // What the failed run is labelled with (the stream's error event).
      assert.equal(toObservationError(error).code, "CHAT_RUN_FAILED");
      return true;
    },
  );
});

test("resolveRouterToolsContext loads batchTriggerIds from the database, not from hostContext", async () => {
  const { teamId, workspaceId, assistant, member } = await setupAssistant();
  const t1 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const t2 = await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
  });
  const batchKey = routerBatchKeyFn([t1.id, t2.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id, t2.id] },
    batchKey,
    { teamId, workspaceId },
  );
  // A third, unrelated in_eval trigger under a *different* batch key must
  // not leak into this batch's resolved triggerIds.
  await f.insertTrigger({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    status: "in_eval",
    routerBatchKey: "some-other-batch",
  });

  const resolved = await resolveRouterToolsContextFn({
    workspaceId,
    teamId,
    threadId: randomUUID(),
    runId: randomUUID(),
    userId: randomUUID(),
    // hostContext carries only assistantId/batchKey — no batchTriggerIds.
    hostContext: {
      assistantId: assistant.id,
      batchKey,
    },
  });
  assert.equal(resolved.assistantId, assistant.id);
  assert.equal(resolved.batchKey, batchKey);
  assert.deepEqual(new Set(resolved.batchTriggerIds), new Set([t1.id, t2.id]));
});

// ── route_to_ticket refusals (rework bound, payer, waiting, ended) ───────

/** Claims one batch holding `triggerIds` for `payer` and routes all of them
 * to `ticketId` in one `route_to_ticket` call; returns the tool's result. */
async function routeBatch(
  s: Awaited<ReturnType<typeof setupAssistant>>,
  input: {
    payer: string;
    ticketId: string;
    triggerIds: string[];
    note?: string;
  },
) {
  const batchKey = routerBatchKeyFn(input.triggerIds);
  await claimBatchFn(
    s.assistant.id,
    { payerUserId: input.payer, triggerIds: input.triggerIds },
    batchKey,
    { teamId: s.teamId, workspaceId: s.workspaceId },
  );
  const tools = createRouterToolsFn(
    routerCtx({
      teamId: s.teamId,
      workspaceId: s.workspaceId,
      assistantId: s.assistant.id,
      batchKey,
      batchTriggerIds: input.triggerIds,
    }),
    f.ports,
  );
  const routeToTicket = tools.find((tool) => tool.name === "route_to_ticket")!;
  return routeToTicket.invoke({
    ticketId: input.ticketId,
    triggerIds: input.triggerIds,
    ...(input.note ? { note: input.note } : {}),
  });
}

/** One pending event for `payer`: a member's message, or `ticketId`'s own
 * report. */
async function pendingEvent(
  s: Awaited<ReturnType<typeof setupAssistant>>,
  input: {
    payer: string;
    sourceKind: "member_message" | "worker_report";
    ticketId?: string;
  },
) {
  return f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: input.payer,
    sourceKind: input.sourceKind,
    authorUserId: input.sourceKind === "member_message" ? input.payer : null,
    ticketId: input.ticketId ?? null,
  });
}

function refusalCode(result: unknown): string | null {
  return isRouterToolErrorFn(result) ? result.code : null;
}

test(`route_to_ticket sends a ticket's own report back at most reworkWithoutMemberMax (${ASSISTANT_LIMITS.reworkWithoutMemberMax}) times; a member's message resets the count`, async () => {
  const s = await setupAssistant();
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "idle",
  });
  const reroute = async () => {
    const report = await pendingEvent(s, {
      payer: s.member,
      sourceKind: "worker_report",
      ticketId: ticket.id,
    });
    const result = await routeBatch(s, {
      payer: s.member,
      ticketId: ticket.id,
      triggerIds: [report.id],
      note: "Put the full text in the report.",
    });
    return { report, result };
  };

  for (let i = 0; i < ASSISTANT_LIMITS.reworkWithoutMemberMax; i += 1) {
    const { result } = await reroute();
    assert.equal(refusalCode(result), null, `reroute ${i + 1} is accepted`);
  }
  const third = await reroute();
  assert.equal(refusalCode(third.result), "TICKET_REWORK_LIMIT_REACHED");
  const message = (third.result as { message: string }).message;
  assert.match(message, /ignore/);
  assert.match(message, /say/);
  // Refused without deciding anything: the event is still the Router's.
  assert.equal((await f.triggerRow(third.report.id))!.status, "in_eval");
  assert.equal(
    (await f.decisionRows(s.assistant.id)).filter(
      (row) => row.triggerId === third.report.id,
    ).length,
    0,
  );

  // The member writes again: their message is routed, and the count starts over.
  const memberMessage = await pendingEvent(s, {
    payer: s.member,
    sourceKind: "member_message",
  });
  assert.equal(
    refusalCode(
      await routeBatch(s, {
        payer: s.member,
        ticketId: ticket.id,
        triggerIds: [memberMessage.id],
      }),
    ),
    null,
  );
  const afterMember = await reroute();
  assert.equal(refusalCode(afterMember.result), null);
});

test("route_to_ticket refuses a worker_report for a blocked ticket but still takes a member's message for it", async () => {
  const s = await setupAssistant();
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "waiting_person",
    outcome: "blocked",
    blockedReason: "repeated_failure",
  });
  const report = await pendingEvent(s, {
    payer: s.member,
    sourceKind: "worker_report",
    ticketId: ticket.id,
  });
  const refused = await routeBatch(s, {
    payer: s.member,
    ticketId: ticket.id,
    triggerIds: [report.id],
  });
  assert.equal(refusalCode(refused), "TICKET_WAITING_FOR_PERSON");
  assert.match((refused as { message: string }).message, /ignore/);
  assert.match((refused as { message: string }).message, /say/);
  assert.equal((await f.triggerRow(report.id))!.status, "in_eval");

  const message = await pendingEvent(s, {
    payer: s.member,
    sourceKind: "member_message",
  });
  const accepted = await routeBatch(s, {
    payer: s.member,
    ticketId: ticket.id,
    triggerIds: [message.id],
  });
  assert.equal(refusalCode(accepted), null);
  assert.equal((await f.triggerRow(message.id))!.routedTicketId, ticket.id);
});

test("route_to_ticket refuses an event paid for by a different member, leaving it undecided; the ticket's own payer is routed", async () => {
  const s = await setupAssistant();
  const other = randomUUID();
  await f.user(other);
  await f.addMember(s.teamId, other, "member");
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "idle",
  });

  const foreign = await pendingEvent(s, {
    payer: other,
    sourceKind: "member_message",
  });
  const refused = await routeBatch(s, {
    payer: other,
    ticketId: ticket.id,
    triggerIds: [foreign.id],
  });
  assert.equal(refusalCode(refused), "TICKET_PAYER_MISMATCH");
  assert.match((refused as { message: string }).message, /create_ticket/);
  const row = await f.triggerRow(foreign.id);
  assert.equal(row!.status, "in_eval");
  assert.equal(row!.routedTicketId, null);
  assert.equal((await f.decisionRows(s.assistant.id)).length, 0);

  const own = await pendingEvent(s, {
    payer: s.member,
    sourceKind: "member_message",
  });
  const accepted = await routeBatch(s, {
    payer: s.member,
    ticketId: ticket.id,
    triggerIds: [own.id],
  });
  assert.equal(refusalCode(accepted), null);
  assert.equal((await f.triggerRow(own.id))!.routedTicketId, ticket.id);
});

test("route_to_ticket refuses an ended ticket and points the Router at create_ticket", async () => {
  const s = await setupAssistant();
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "ended",
  });
  const message = await pendingEvent(s, {
    payer: s.member,
    sourceKind: "member_message",
  });
  const refused = await routeBatch(s, {
    payer: s.member,
    ticketId: ticket.id,
    triggerIds: [message.id],
  });
  assert.equal(refusalCode(refused), "TICKET_ENDED");
  assert.match((refused as { message: string }).message, /create_ticket/);
  assert.equal((await f.triggerRow(message.id))!.status, "in_eval");
});

test("ended tickets are left out of a batch's related tickets", async () => {
  const s = await setupAssistant();
  const open = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "idle",
    title: "Still open",
  });
  const ended = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.member,
    stage: "ended",
    title: "Closed",
  });
  const { fetchRouterBatchContext } = await import("./render");
  const context = await fetchRouterBatchContext({
    assistantId: s.assistant.id,
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    payerUserId: s.member,
    // Even a report from the ended ticket does not bring it back.
    reportingTicketIds: [ended.id],
  });
  const ids = context.relatedTickets.map((ticket) => ticket.id);
  assert.deepEqual(ids, [open.id]);
});

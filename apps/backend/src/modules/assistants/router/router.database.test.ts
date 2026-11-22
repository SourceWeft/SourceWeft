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
      (row) => row.action === "create_ticket" && row.ticketId === result.ticketId,
    ),
  );

  const feed = await f.feedItemRows(assistant.id);
  assert.equal(
    feed.filter((item) => item.kind === "ticket_update" && item.ticketId === result.ticketId)
      .length,
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
  const t1 = await f.insertTrigger({ teamId, workspaceId, assistantId: assistant.id, payerUserId: member });
  const t2 = await f.insertTrigger({ teamId, workspaceId, assistantId: assistant.id, payerUserId: member });
  const t3 = await f.insertTrigger({ teamId, workspaceId, assistantId: assistant.id, payerUserId: member });

  // Cycle 1: claim all three, decide only t1 (`ignore`), leave t2/t3 in_eval.
  let batchKey = routerBatchKeyFn([t1.id, t2.id, t3.id]);
  await claimBatchFn(
    assistant.id,
    { payerUserId: member, triggerIds: [t1.id, t2.id, t3.id] },
    batchKey,
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

// ── resolveRouterToolsContext ────────────────────────────────────────────

test("resolveRouterToolsContext throws when hostContext is missing the Router fields", async () => {
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
        batchTriggerIds: JSON.stringify(["a"]),
      },
    }),
  );
});

test("resolveRouterToolsContext resolves a valid hostContext into the Router tools context", async () => {
  const { teamId, workspaceId, assistant } = await setupAssistant();
  const resolved = await resolveRouterToolsContextFn({
    workspaceId,
    teamId,
    threadId: randomUUID(),
    runId: randomUUID(),
    userId: randomUUID(),
    hostContext: {
      assistantId: assistant.id,
      batchKey: "key-1",
      batchTriggerIds: JSON.stringify(["t1", "t2"]),
    },
  });
  assert.equal(resolved.assistantId, assistant.id);
  assert.equal(resolved.batchKey, "key-1");
  assert.deepEqual(resolved.batchTriggerIds, ["t1", "t2"]);
});

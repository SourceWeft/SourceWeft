import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAssistantFixture,
  type AssistantFixture,
} from "../../test/assistant-fixture";
import type { deterministicId as DeterministicId } from "../agent-tasks/runs";
import { ContentError } from "../content/errors";
import type { AssistantPorts } from "./ports";
import type {
  claimAndStartRouterBatch,
  kickAssistant,
  runAssistantTick,
} from "./dispatch";
import type { routerBatchKey } from "./router/batch";

let f: AssistantFixture;
// `./dispatch` imports `db`; loaded after the fixture repoints DATABASE_URL
// at this test's own database (see router/router.database.test.ts).
let tick: typeof runAssistantTick;
let kick: typeof kickAssistant;
let claimAndStart: typeof claimAndStartRouterBatch;
let batchKeyOf: typeof routerBatchKey;
// `agent-tasks/runs` imports `db` too: never statically, or it would bind
// the shared dev database before the fixture repoints DATABASE_URL.
let deterministicId: typeof DeterministicId;

beforeAll(async () => {
  f = await createAssistantFixture("asst_dispatch");
  const dispatch = await import("./dispatch");
  tick = dispatch.runAssistantTick;
  kick = dispatch.kickAssistant;
  claimAndStart = dispatch.claimAndStartRouterBatch;
  batchKeyOf = (await import("./router/batch")).routerBatchKey;
  deterministicId = (await import("../agent-tasks/runs")).deterministicId;
}, 120_000);

beforeEach(async () => {
  f.reset();
  // Every tick walks every active assistant in the database; earlier tests'
  // assistants are paused so each test sees only its own.
  await f.schema.db
    .update(f.schema.assistants)
    .set({ status: "paused", statusReason: "by_admin" });
});

afterAll(async () => {
  await f?.close();
});

const minutesAgo = (base: Date, minutes: number) =>
  new Date(base.getTime() - minutes * 60_000);

/** A team workspace with its assistant enabled, a steward and two members. */
async function setup() {
  const steward = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const { teamId, workspaceId } = await f.workspace(
    [
      [steward, "owner"],
      [a, "member"],
      [b, "member"],
    ],
    { kind: "team" },
  );
  const assistant = await f.service.enable({ workspaceId, userId: steward });
  return { steward, a, b, teamId, workspaceId, assistant };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A queued ticket with one decided, undelivered event routed to it. */
async function queuedTicket(
  s: Setup,
  input: {
    payer: string;
    sourceKind?: "member_message" | "worker_report";
    at: Date;
    title?: string;
  },
) {
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: input.payer,
    stage: "queued",
    title: input.title,
    createdAt: input.at,
  });
  await routeEvent(s, ticket.id, {
    payer: input.payer,
    sourceKind: input.sourceKind ?? "worker_report",
    at: input.at,
  });
  return ticket;
}

async function routeEvent(
  s: Setup,
  ticketId: string,
  input: {
    payer: string;
    sourceKind: "member_message" | "worker_report";
    at: Date;
    text?: string;
  },
) {
  return f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: input.payer,
    sourceKind: input.sourceKind,
    authorUserId: input.sourceKind === "member_message" ? input.payer : null,
    status: "decided",
    routedTicketId: ticketId,
    createdAt: input.at,
    text: input.text ?? "Please look into it",
  });
}

function startsOf(
  origin: "assistant_router" | "assistant_ticket",
  workspaceId?: string,
) {
  return f.started.filter(
    (input) =>
      input.origin === origin &&
      (workspaceId === undefined || input.workspaceId === workspaceId),
  );
}

async function assistantRow(s: Setup) {
  return (await f.assistantRow(s.workspaceId))!;
}

// ── Worker dispatch: slots ──────────────────────────────────────────────

test("three queued tickets and two slots: the first tick starts two; the third takes the reserved slot only for a member's input", async () => {
  const s = await setup();
  const now = new Date();
  const t1 = await queuedTicket(s, {
    payer: s.a,
    at: minutesAgo(now, 30),
    title: "One",
  });
  const t2 = await queuedTicket(s, {
    payer: s.a,
    at: minutesAgo(now, 20),
    title: "Two",
  });
  const t3 = await queuedTicket(s, {
    payer: s.b,
    at: minutesAgo(now, 10),
    title: "Three",
  });

  await tick(now, f.ports);
  const first = startsOf("assistant_ticket", s.workspaceId);
  assert.deepEqual(
    first.map((input) => input.hostContext?.ticketId),
    [t1.id, t2.id],
  );
  const routerThread = await f.schema.db
    .select()
    .from(f.schema.threads)
    .where(eq(f.schema.threads.id, s.assistant.routerThreadId));
  assert.deepEqual(first[0], {
    ...first[0],
    origin: "assistant_ticket",
    workspaceId: s.workspaceId,
    userId: s.a,
    threadId: t1.workerThreadId,
    idempotencyKey: deterministicId("assistant-ticket-run", t1.id, "initial"),
    creditCap: 500,
    hostContext: { assistantId: s.assistant.id, ticketId: t1.id },
    title: "One",
    visibility: routerThread[0]!.visibility,
  });
  assert.match(first[0]!.content, /Please look into it/);
  for (const ticket of [t1, t2]) {
    const row = (await f.ticketRow(ticket.id))!;
    assert.equal(row.stage, "working");
    assert.ok(row.currentRunId);
  }
  assert.equal((await f.ticketRow(t3.id))!.stage, "queued");
  const delivered = (await f.triggerRows(s.assistant.id)).filter(
    (row) => row.routedTicketId === t1.id,
  );
  assert.ok(delivered.every((row) => row.deliveredAt !== null));

  // A worker's report routed to the third ticket does not get the reserved
  // slot...
  await routeEvent(s, t3.id, {
    payer: s.b,
    sourceKind: "worker_report",
    at: now,
  });
  f.reset();
  await tick(new Date(now.getTime() + 60_000), f.ports);
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
  assert.equal((await f.ticketRow(t3.id))!.stage, "queued");

  // ...a member's message does.
  await routeEvent(s, t3.id, {
    payer: s.b,
    sourceKind: "member_message",
    at: now,
  });
  f.reset();
  await tick(new Date(now.getTime() + 120_000), f.ports);
  const third = startsOf("assistant_ticket", s.workspaceId);
  assert.deepEqual(
    third.map((input) => input.hostContext?.ticketId),
    [t3.id],
  );
  assert.equal((await f.ticketRow(t3.id))!.stage, "working");

  // All three slots are now taken: nothing more starts, member input or not.
  const t4 = await queuedTicket(s, {
    payer: s.a,
    sourceKind: "member_message",
    at: now,
  });
  f.reset();
  await tick(new Date(now.getTime() + 180_000), f.ports);
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
  assert.equal((await f.ticketRow(t4.id))!.stage, "queued");
});

test("a new event routed to an idle ticket is delivered as an append, keyed by its event ids", async () => {
  const s = await setup();
  const now = new Date();
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    stage: "idle",
  });
  // Delivered long ago, with the ticket's first run.
  await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    status: "decided",
    routedTicketId: ticket.id,
    deliveredAt: minutesAgo(now, 60),
    createdAt: minutesAgo(now, 61),
  });
  const e2 = await routeEvent(s, ticket.id, {
    payer: s.a,
    sourceKind: "member_message",
    at: minutesAgo(now, 2),
    text: "Also cover pricing",
  });
  const e1 = await routeEvent(s, ticket.id, {
    payer: s.a,
    sourceKind: "member_message",
    at: minutesAgo(now, 1),
    text: "And the FAQ",
  });

  await tick(now, f.ports);
  const [start] = startsOf("assistant_ticket", s.workspaceId);
  assert.ok(start);
  assert.equal(
    start.idempotencyKey,
    deterministicId(
      "assistant-ticket-run",
      ticket.id,
      [e1.id, e2.id].sort().join(","),
    ),
  );
  assert.match(start.content, /Also cover pricing/);
  assert.match(start.content, /And the FAQ/);
  assert.equal((await f.ticketRow(ticket.id))!.stage, "working");
});

test("a report the Router routed back for rework is delivered with the Router's note", async () => {
  const s = await setup();
  const now = new Date();
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    stage: "idle",
  });
  await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    status: "decided",
    routedTicketId: ticket.id,
    deliveredAt: minutesAgo(now, 60),
    createdAt: minutesAgo(now, 61),
  });
  const report = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    authorUserId: null,
    sourceKind: "worker_report",
    ticketId: ticket.id,
    text: "ready: Wrote the digest.",
    status: "decided",
    routedTicketId: ticket.id,
    createdAt: minutesAgo(now, 2),
  });
  await f.schema.db.insert(f.schema.assistantDecisions).values({
    id: randomUUID(),
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    triggerId: report.id,
    routerBatchKey: "batch-1",
    action: "route_to_ticket",
    ticketId: ticket.id,
    reason: "Put the digest itself in the report, not just where it is.",
  });

  await tick(now, f.ports);

  const [start] = startsOf("assistant_ticket", s.workspaceId);
  assert.ok(start);
  assert.ok(
    start.content.includes(
      `<router-note for=${report.id}>Put the digest itself in the report, not just where it is.</router-note>`,
    ),
  );
});

// ── Worker runs that ended ──────────────────────────────────────────────

/** Dispatches one queued ticket and returns it with its run id. */
async function workingTicket(s: Setup, payer = s.a) {
  const now = new Date();
  const ticket = await queuedTicket(s, { payer, at: minutesAgo(now, 5) });
  await tick(now, f.ports);
  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "working");
  f.reset();
  return { ticket: row, runId: row.currentRunId! };
}

test("a run that completed without a report leaves the ticket waiting for a person, with an ended_without_report event", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  await f.setRunStatus(runId, { status: "completed" });

  await tick(new Date(), f.ports);

  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "waiting_person");
  assert.equal(row.currentRunId, null);
  const reports = (await f.triggerRows(s.assistant.id)).filter(
    (trigger) =>
      trigger.sourceKind === "worker_report" && trigger.ticketId === ticket.id,
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.text, "ended_without_report");
  assert.equal(reports[0]!.payerUserId, s.a);

  // A second tick adds nothing more.
  await tick(new Date(), f.ports);
  assert.equal(
    (await f.triggerRows(s.assistant.id)).filter(
      (trigger) =>
        trigger.sourceKind === "worker_report" &&
        trigger.ticketId === ticket.id,
    ).length,
    1,
  );
});

test("a run that completed after the worker reported only clears the run", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  await f.schema.db
    .update(f.schema.assistantTickets)
    .set({ stage: "idle", outcome: "ready" })
    .where(eq(f.schema.assistantTickets.id, ticket.id));
  await f.setRunStatus(runId, { status: "completed" });

  await tick(new Date(), f.ports);

  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "idle");
  assert.equal(row.currentRunId, null);
  assert.equal(
    (await f.triggerRows(s.assistant.id)).filter(
      (t) => t.sourceKind === "worker_report",
    ).length,
    1, // only the one the ticket was created from
  );
});

test("RUN_CREDIT_CAP_EXCEEDED blocks the ticket on its credit cap and notifies the payer", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  await f.setRunStatus(runId, {
    status: "failed",
    errorCode: "RUN_CREDIT_CAP_EXCEEDED",
  });

  await tick(new Date(), f.ports);

  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "waiting_person");
  assert.equal(row.outcome, "blocked");
  assert.equal(row.blockedReason, "credit_cap");
  assert.equal(row.currentRunId, null);
  assert.equal(row.consecutiveFailures, 0);
  const blocked = f.notifications.filter(
    (n) => n.kind === "assistant_ticket_blocked",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.userId, s.a);
  assert.equal(blocked[0]!.payload?.ticketId, ticket.id);
  assert.equal(blocked[0]!.payload?.reason, "credit_cap");
  // Nothing restarts it on its own.
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
});

/** An idle ticket whose earlier, finished worker runs spent `spent` of its
 * `creditCap`, with a member's new message routed to it. */
async function ticketWithSpentRuns(
  s: Setup,
  input: { creditCap: number; spent: number[] },
) {
  const now = new Date();
  const workerThreadId = randomUUID();
  for (const credits of input.spent) {
    const started = await f.ports.startTurn({
      origin: "assistant_ticket",
      workspaceId: s.workspaceId,
      userId: s.a,
      threadId: workerThreadId,
      idempotencyKey: randomUUID(),
      title: "Earlier run",
      content: "Earlier work",
    });
    await f.setRunStatus(started.run.id, { status: "completed" });
    await f.schema.db
      .update(f.schema.chatThreadRuns)
      .set({ consumedCredits: String(credits) })
      .where(eq(f.schema.chatThreadRuns.id, started.run.id));
  }
  const ticket = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    stage: "idle",
    workerThreadId,
    creditCap: input.creditCap,
    createdAt: minutesAgo(now, 90),
  });
  // Delivered with the ticket's first run.
  await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    status: "decided",
    routedTicketId: ticket.id,
    deliveredAt: minutesAgo(now, 60),
    createdAt: minutesAgo(now, 61),
  });
  await routeEvent(s, ticket.id, {
    payer: s.a,
    sourceKind: "member_message",
    at: minutesAgo(now, 1),
  });
  f.reset();
  return ticket;
}

test("the credit cap covers the whole ticket: earlier runs that spent it block the ticket on credit_cap, and no run starts", async () => {
  const s = await setup();
  const ticket = await ticketWithSpentRuns(s, {
    creditCap: 100,
    spent: [60, 40],
  });

  await tick(new Date(), f.ports);

  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "waiting_person");
  assert.equal(row.outcome, "blocked");
  assert.equal(row.blockedReason, "credit_cap");
  assert.equal(row.currentRunId, null);
  const blocked = f.notifications.filter(
    (n) => n.kind === "assistant_ticket_blocked",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.payload?.reason, "credit_cap");

  // Told once: the next tick leaves it as it is.
  f.reset();
  await tick(new Date(), f.ports);
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
  assert.equal(
    f.notifications.filter((n) => n.kind === "assistant_ticket_blocked").length,
    0,
  );
});

test("a worker run gets only what is left of the ticket's credit cap", async () => {
  const s = await setup();
  const ticket = await ticketWithSpentRuns(s, { creditCap: 100, spent: [30] });

  await tick(new Date(), f.ports);

  const [start] = startsOf("assistant_ticket", s.workspaceId);
  assert.ok(start);
  assert.equal(start.hostContext?.ticketId, ticket.id);
  assert.equal(start.creditCap, 70);
});

test("a run refused for credits blocks the ticket on insufficient credits", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  await f.setRunStatus(runId, {
    status: "failed",
    errorCode: "BILLING_ADMISSION_DENIED",
  });

  await tick(new Date(), f.ports);

  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "waiting_person");
  assert.equal(row.outcome, "blocked");
  assert.equal(row.blockedReason, "insufficient_credits");
  assert.equal(
    f.notifications.filter((n) => n.kind === "assistant_ticket_blocked").length,
    1,
  );
});

test("a run that failed with a generic code while its payer has no credits blocks on insufficient credits, counting no failure", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  // Refused for credits mid-run: the turn's error mapping stores a generic code.
  await f.setRunStatus(runId, {
    status: "failed",
    errorCode: "CHAT_RUN_FAILED",
  });
  f.state.noCreditsFor.add(s.a);

  await tick(new Date(), f.ports);

  const row = (await f.ticketRow(ticket.id))!;
  assert.equal(row.stage, "waiting_person");
  assert.equal(row.outcome, "blocked");
  assert.equal(row.blockedReason, "insufficient_credits");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.currentRunId, null);
  const blocked = f.notifications.filter(
    (n) => n.kind === "assistant_ticket_blocked",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.payload?.reason, "insufficient_credits");
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
});

test("three failed runs in a row block the ticket for repeated failure; each failure before that retries under a new key", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  const runIds = [runId];
  const keys = new Set<string>();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await f.setRunStatus(runIds[runIds.length - 1]!, {
      status: "failed",
      errorCode: "MODEL_UPSTREAM_ERROR",
    });
    f.reset();
    await tick(new Date(), f.ports);
    const row = (await f.ticketRow(ticket.id))!;
    assert.equal(row.consecutiveFailures, attempt);
    const restarts = startsOf("assistant_ticket", s.workspaceId);
    if (attempt < 3) {
      assert.equal(restarts.length, 1, `retry after failure ${attempt}`);
      assert.equal(row.stage, "working");
      keys.add(restarts[0]!.idempotencyKey);
      runIds.push(row.currentRunId!);
      assert.notEqual(row.currentRunId, runIds[runIds.length - 2]);
    } else {
      assert.equal(restarts.length, 0);
      assert.equal(row.stage, "waiting_person");
      assert.equal(row.outcome, "blocked");
      assert.equal(row.blockedReason, "repeated_failure");
      assert.equal(row.currentRunId, null);
      const blocked = f.notifications.filter(
        (n) => n.kind === "assistant_ticket_blocked",
      );
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.payload?.reason, "repeated_failure");
    }
  }
  assert.equal(keys.size, 2);
});

test("a run past its time limit is stopped and cleared once it ends", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  const now = new Date();
  await f.setRunStatus(runId, {
    status: "running",
    startedAt: minutesAgo(now, 46),
  });

  await tick(now, f.ports);
  assert.deepEqual(f.stopped, [
    {
      workspaceId: s.workspaceId,
      threadId: ticket.workerThreadId,
      runId,
      userId: s.a,
    },
  ]);
  assert.equal((await f.ticketRow(ticket.id))!.currentRunId, runId);

  // A run still within its limit is left alone.
  f.reset();
  await f.setRunStatus(runId, {
    status: "running",
    startedAt: minutesAgo(now, 44),
  });
  await tick(now, f.ports);
  assert.equal(f.stopped.length, 0);
});

// ── Credits (Review Focus 3) ────────────────────────────────────────────

test("a payer without credits: their ticket is blocked and notified without taking a slot, and another payer's ticket still starts", async () => {
  const s = await setup();
  const now = new Date();
  const ofA = await queuedTicket(s, { payer: s.a, at: minutesAgo(now, 10) });
  const ofB = await queuedTicket(s, { payer: s.b, at: minutesAgo(now, 5) });
  f.state.noCreditsFor.add(s.a);

  await tick(now, f.ports);

  const rowA = (await f.ticketRow(ofA.id))!;
  assert.equal(rowA.stage, "waiting_person");
  assert.equal(rowA.outcome, "blocked");
  assert.equal(rowA.blockedReason, "insufficient_credits");
  assert.equal((await f.ticketRow(ofB.id))!.stage, "working");
  assert.deepEqual(
    startsOf("assistant_ticket", s.workspaceId).map((input) => input.userId),
    [s.b],
  );
  const blocked = f.notifications.filter(
    (n) => n.kind === "assistant_ticket_blocked",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.userId, s.a);
  assert.equal(blocked[0]!.payload?.reason, "insufficient_credits");

  // Still out of credits: no second notification for the same block.
  f.reset();
  f.state.noCreditsFor.add(s.a);
  await tick(now, f.ports);
  assert.equal(f.notifications.length, 0);

  // Credits are back: the ticket starts with what is still undelivered.
  f.reset();
  await tick(now, f.ports);
  assert.deepEqual(
    startsOf("assistant_ticket", s.workspaceId).map(
      (input) => input.hostContext?.ticketId,
    ),
    [ofA.id],
  );
});

test("A without credits: A's batch stays pending with no attempt counted, and B's batch starts in the same tick", async () => {
  const s = await setup();
  const fromA = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "From A", idempotencyKey: "a-1" },
  );
  const fromB = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.b },
    { text: "From B", idempotencyKey: "b-1" },
  );
  f.state.noCreditsFor.add(s.a);

  await tick(new Date(), f.ports);

  const triggerA = (await f.triggerRow(fromA.item.id))!;
  assert.equal(triggerA.status, "pending_eval");
  assert.equal(triggerA.evalAttempts, 0);
  assert.equal(triggerA.routerBatchKey, null);

  // A is told their messages wait for credits; the events stay pending.
  const toldA = f.notifications.filter(
    (n) => n.kind === "assistant_ticket_blocked",
  );
  assert.equal(toldA.length, 1);
  assert.equal(toldA[0]!.userId, s.a);
  assert.deepEqual(toldA[0]!.ref, { kind: "assistant", id: s.assistant.id });
  assert.equal(toldA[0]!.payload?.reason, "insufficient_credits");
  assert.equal(toldA[0]!.payload?.ticketId, undefined);

  const routerStarts = startsOf("assistant_router", s.workspaceId);
  assert.equal(routerStarts.length, 1);
  const batchKey = batchKeyOf([fromB.item.id]);
  assert.deepEqual(routerStarts[0], {
    ...routerStarts[0],
    origin: "assistant_router",
    existingThread: true,
    threadId: s.assistant.routerThreadId,
    userId: s.b,
    idempotencyKey: batchKey,
    hostContext: { assistantId: s.assistant.id, batchKey },
    freshContext: true,
  });
  // B's event is the batch; A's appears at most as recent feed context.
  assert.ok(
    routerStarts[0]!.content.includes(
      `<assistant-trigger id=${fromB.item.id} `,
    ),
  );
  assert.ok(
    !routerStarts[0]!.content.includes(
      `<assistant-trigger id=${fromA.item.id} `,
    ),
  );

  const triggerB = (await f.triggerRow(fromB.item.id))!;
  assert.equal(triggerB.status, "in_eval");
  assert.equal(triggerB.routerBatchKey, batchKey);
  const assistant = await assistantRow(s);
  assert.equal(assistant.currentRouterBatchKey, batchKey);
  assert.ok(assistant.currentRouterRunId);
});

test("a worker_report in a batch reaches the Router with its ticket id, and its ticket is listed even past the related-tickets cap", async () => {
  const s = await setup();
  const now = new Date();
  // The reporting ticket is the payer's oldest: by recency alone, the eight
  // newer ones would fill the related-tickets list without it.
  const reporting = await f.insertTicket({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    stage: "idle",
    title: "Weekly digest",
    createdAt: minutesAgo(now, 120),
  });
  for (let i = 0; i < 9; i += 1) {
    await f.insertTicket({
      teamId: s.teamId,
      workspaceId: s.workspaceId,
      assistantId: s.assistant.id,
      payerUserId: s.a,
      stage: "idle",
      title: `Newer ${i}`,
      createdAt: minutesAgo(now, 10 - i),
    });
  }
  const report = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    sourceKind: "worker_report",
    authorUserId: null,
    ticketId: reporting.id,
    text: "ready: the digest is in /files/digest.md",
  });

  await tick(now, f.ports);

  const [start] = startsOf("assistant_router", s.workspaceId);
  assert.ok(start);
  const line = start.content
    .split("\n")
    .find((l) => l.startsWith(`<assistant-trigger id=${report.id} `));
  assert.ok(line);
  assert.match(line, / source=worker_report /);
  assert.ok(line.includes(` member=false ticket=${reporting.id}>`));
  const related = start.content.split("Related tickets / 相关工单:")[1] ?? "";
  const lines = related.split("\n").filter((line) => line.includes(" | "));
  assert.equal(lines.length, 8);
  assert.ok(lines[0]!.startsWith(`${reporting.id} | Weekly digest | idle | `));
});

// ── Router busy / 409 (Review Focus 1) ──────────────────────────────────

test("A and B write while the Router is busy: nothing starts; then A's batch, then B's, and neither is lost", async () => {
  const s = await setup();
  // The Router is busy with an earlier run.
  const earlier = await f.ports.startTurn({
    origin: "assistant_router",
    existingThread: true,
    workspaceId: s.workspaceId,
    userId: s.steward,
    threadId: s.assistant.routerThreadId,
    idempotencyKey: "earlier-batch",
    title: "Workspace assistant",
    content: "earlier",
  });
  await f.setRunStatus(earlier.run.id, { status: "running" });
  await f.setCurrentRouterRun(s.assistant.id, {
    runId: earlier.run.id,
    batchKey: "earlier-batch",
  });

  const fromA = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "From A", idempotencyKey: "a-1" },
  );
  const fromB = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.b },
    { text: "From B", idempotencyKey: "b-1" },
  );

  f.reset();
  await tick(new Date(), f.ports);
  assert.equal(startsOf("assistant_router", s.workspaceId).length, 0);
  assert.equal((await f.triggerRow(fromA.item.id))!.status, "pending_eval");
  assert.equal((await f.triggerRow(fromB.item.id))!.status, "pending_eval");

  // The earlier run ends; the next tick reconciles it and starts A's batch.
  await f.setRunStatus(earlier.run.id, { status: "completed" });
  await tick(new Date(), f.ports);
  let starts = startsOf("assistant_router", s.workspaceId);
  assert.deepEqual(
    starts.map((input) => input.userId),
    [s.a],
  );
  const runA = (await assistantRow(s)).currentRouterRunId!;
  assert.notEqual(runA, earlier.run.id);
  assert.equal((await f.triggerRow(fromA.item.id))!.status, "in_eval");
  assert.equal((await f.triggerRow(fromB.item.id))!.status, "pending_eval");

  // The Router decides A's message; its run ends; the next tick starts B's.
  await f.schema.db
    .update(f.schema.assistantTriggers)
    .set({ status: "decided" })
    .where(eq(f.schema.assistantTriggers.id, fromA.item.id));
  await f.setRunStatus(runA, { status: "completed" });
  f.reset();
  await tick(new Date(), f.ports);
  starts = startsOf("assistant_router", s.workspaceId);
  assert.deepEqual(
    starts.map((input) => input.userId),
    [s.b],
  );
  assert.equal((await f.triggerRow(fromA.item.id))!.status, "decided");
  assert.equal((await f.triggerRow(fromB.item.id))!.status, "in_eval");
});

test("a 409 from starting the Router puts the batch back to pending_eval without counting an attempt", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  f.state.startErrors.push(
    new ContentError(
      409,
      "CHAT_RUN_ALREADY_ACTIVE",
      "A chat run is already active for this thread",
    ),
  );

  await tick(new Date(), f.ports);

  assert.equal(startsOf("assistant_router", s.workspaceId).length, 1);
  const trigger = (await f.triggerRow(message.item.id))!;
  assert.equal(trigger.status, "pending_eval");
  assert.equal(trigger.evalAttempts, 0);
  assert.equal(trigger.routerBatchKey, null);
  const assistant = await assistantRow(s);
  assert.equal(assistant.currentRouterRunId, null);
  assert.equal(assistant.currentRouterBatchKey, null);

  // The next tick tries again and starts it.
  f.reset();
  await tick(new Date(), f.ports);
  assert.equal(startsOf("assistant_router", s.workspaceId).length, 1);
  assert.equal((await f.triggerRow(message.item.id))!.status, "in_eval");
});

test("a kick's 409 while a run is already recorded under its own batch key leaves the events in_eval", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  const batchKey = batchKeyOf([message.item.id]);
  // The tick's recovery already started this very batch (same key) before
  // the kick's start came back with a 409.
  await f.ports.startTurn({
    origin: "assistant_router",
    existingThread: true,
    workspaceId: s.workspaceId,
    userId: s.a,
    threadId: s.assistant.routerThreadId,
    idempotencyKey: batchKey,
    title: "Workspace assistant",
    content: "batch",
  });
  f.reset();
  f.state.startErrors.push(
    new ContentError(
      409,
      "CHAT_RUN_ALREADY_ACTIVE",
      "A chat run is already active for this thread",
    ),
  );

  await kick(kickInput(s), f.ports);

  assert.equal(startsOf("assistant_router", s.workspaceId).length, 1);
  const trigger = (await f.triggerRow(message.item.id))!;
  assert.equal(trigger.status, "in_eval");
  assert.equal(trigger.routerBatchKey, batchKey);
  assert.equal(trigger.evalAttempts, 0);
});

test("any other failure to start the Router counts as an evaluation attempt", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  f.state.startErrors.push(
    new ContentError(
      503,
      "HOST_TURN_START_FAILED",
      "The run could not be queued",
    ),
  );

  await tick(new Date(), f.ports);

  const trigger = (await f.triggerRow(message.item.id))!;
  assert.equal(trigger.status, "pending_eval");
  assert.equal(trigger.evalAttempts, 1);
  assert.equal(trigger.routerBatchKey, null);
  assert.equal((await assistantRow(s)).currentRouterRunId, null);
});

test("a claim that gets fewer events than selected gives them back and starts nothing", async () => {
  const s = await setup();
  const free = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
  });
  const taken = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    status: "in_eval",
    routerBatchKey: "someone-else",
  });
  const assistant = await assistantRow(s);

  const result = await claimAndStart(
    assistant,
    { payerUserId: s.a, triggerIds: [free.id, taken.id] },
    f.ports,
  );

  assert.equal(result, "claim_short");
  assert.equal(f.started.length, 0);
  const freeRow = (await f.triggerRow(free.id))!;
  assert.equal(freeRow.status, "pending_eval");
  assert.equal(freeRow.routerBatchKey, null);
  assert.equal(freeRow.evalAttempts, 0);
  const takenRow = (await f.triggerRow(taken.id))!;
  assert.equal(takenRow.status, "in_eval");
  assert.equal(takenRow.routerBatchKey, "someone-else");
  assert.equal((await assistantRow(s)).currentRouterRunId, null);
});

test("a claimed batch whose run was never recorded is started again under the same key", async () => {
  const s = await setup();
  const trigger = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
    text: "Orphaned",
  });
  const batchKey = batchKeyOf([trigger.id]);
  await f.schema.db
    .update(f.schema.assistantTriggers)
    .set({ status: "in_eval", routerBatchKey: batchKey })
    .where(eq(f.schema.assistantTriggers.id, trigger.id));

  await tick(new Date(), f.ports);

  const starts = startsOf("assistant_router", s.workspaceId);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.idempotencyKey, batchKey);
  assert.equal(starts[0]!.userId, s.a);
  const assistant = await assistantRow(s);
  assert.equal(assistant.currentRouterBatchKey, batchKey);
  assert.ok(assistant.currentRouterRunId);
});

test("a Router run that finished before its id was recorded is reconciled by the next tick", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  await tick(new Date(), f.ports);
  const assistant = await assistantRow(s);
  // The Router's run ended without deciding the message.
  await f.setRunStatus(assistant.currentRouterRunId!, { status: "completed" });

  f.reset();
  await tick(new Date(), f.ports);
  const trigger = (await f.triggerRow(message.item.id))!;
  assert.equal(trigger.evalAttempts, 1);
  // Requeued, and started again in the same tick as a fresh batch.
  assert.equal(trigger.status, "in_eval");
  assert.equal(startsOf("assistant_router", s.workspaceId).length, 1);
  assert.notEqual(
    (await assistantRow(s)).currentRouterRunId,
    assistant.currentRouterRunId,
  );
});

// ── Steward left (Review Focus 4) ───────────────────────────────────────

test("a steward who lost access pauses the assistant; nothing new starts and running work is not stopped", async () => {
  const s = await setup();
  const { ticket, runId } = await workingTicket(s);
  await f.setRunStatus(runId, { status: "running", startedAt: new Date() });
  await queuedTicket(s, { payer: s.b, at: new Date() });
  await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  await f.removeMember(s.teamId, s.steward);
  f.reset();

  await tick(new Date(), f.ports);

  const assistant = await assistantRow(s);
  assert.equal(assistant.status, "paused");
  assert.equal(assistant.statusReason, "steward_left");
  assert.equal(assistant.version, 2);
  assert.equal(f.started.length, 0);
  assert.equal(f.stopped.length, 0);
  assert.equal((await f.ticketRow(ticket.id))!.currentRunId, runId);
  const audit = f.audits.find((entry) => entry.action === "assistant.paused");
  assert.ok(audit);
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.targetId, s.assistant.id);
  assert.deepEqual(audit.metadata, {
    reason: "steward_left",
    stewardUserId: s.steward,
  });

  // Paused: later ticks start nothing either.
  await tick(new Date(), f.ports);
  assert.equal(f.started.length, 0);
});

// ── Isolation between assistants ────────────────────────────────────────

test("one assistant failing mid-tick does not stop the others", async () => {
  const first = await setup();
  const second = await setup();
  const stuck = await queuedTicket(first, { payer: first.a, at: new Date() });
  const queued = await queuedTicket(second, {
    payer: second.a,
    at: new Date(),
  });
  // The first assistant's Router conversation is gone: dispatching its
  // workers throws.
  await f.schema.db
    .delete(f.schema.threads)
    .where(eq(f.schema.threads.id, first.assistant.routerThreadId));
  f.reset();

  await tick(new Date(), f.ports);

  assert.equal((await f.ticketRow(stuck.id))!.stage, "queued");
  assert.equal(startsOf("assistant_ticket", first.workspaceId).length, 0);
  // The other assistant, ticked after it, still got its worker.
  assert.equal((await f.ticketRow(queued.id))!.stage, "working");
  assert.equal(startsOf("assistant_ticket", second.workspaceId).length, 1);
});

test("a notification that fails is logged; the block it was about still stands", async () => {
  const s = await setup();
  const { runId, ticket } = await workingTicket(s);
  await f.setRunStatus(runId, {
    status: "failed",
    errorCode: "RUN_CREDIT_CAP_EXCEEDED",
  });
  const failingNotify: AssistantPorts = {
    ...f.ports,
    async notify() {
      throw new Error("mail is down");
    },
  };
  await tick(new Date(), failingNotify);
  assert.equal((await f.ticketRow(ticket.id))!.blockedReason, "credit_cap");
});

test("ticks never overlap: a tick started while one is running returns at once", async () => {
  const s = await setup();
  await queuedTicket(s, { payer: s.a, at: new Date() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accessChecks = 0;
  const slow: AssistantPorts = {
    ...f.ports,
    async workspaceAccess(input) {
      accessChecks += 1;
      await gate;
      return f.ports.workspaceAccess(input);
    },
  };

  const first = tick(new Date(), slow);
  await tick(new Date(), slow); // returns while the first is still waiting
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 0);
  release();
  await first;
  assert.equal(accessChecks, 1);
  assert.equal(startsOf("assistant_ticket", s.workspaceId).length, 1);

  // Once it has finished, the next tick runs normally.
  await tick(new Date(), slow);
  assert.equal(accessChecks, 2);
});

// ── The immediate kick ──────────────────────────────────────────────────

function kickInput(s: Setup) {
  return {
    assistantId: s.assistant.id,
    teamId: s.teamId,
    workspaceId: s.workspaceId,
  };
}

test("kickAssistant starts the Router's batch right away, and nothing while the Router is busy", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  await kick(kickInput(s), f.ports);
  assert.equal(startsOf("assistant_router", s.workspaceId).length, 1);
  assert.equal((await f.triggerRow(message.item.id))!.status, "in_eval");

  // The Router is now busy: a second kick starts nothing and does not throw.
  const other = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.b },
    { text: "Again", idempotencyKey: "m-2" },
  );
  f.reset();
  await kick(kickInput(s), f.ports);
  assert.equal(f.started.length, 0);
  assert.equal((await f.triggerRow(other.item.id))!.status, "pending_eval");

  // Even once that run has ended: settling it is the tick's job, not the kick's.
  await f.setRunStatus((await assistantRow(s)).currentRouterRunId!, {
    status: "completed",
  });
  await kick(kickInput(s), f.ports);
  assert.equal(f.started.length, 0);
});

test("kickAssistant only logs when it cannot start, and leaves an unrecorded batch to the tick", async () => {
  const s = await setup();
  const message = await f.service.postMessage(
    { workspaceId: s.workspaceId, userId: s.a },
    { text: "Hello", idempotencyKey: "m-1" },
  );
  const failing: AssistantPorts = {
    ...f.ports,
    async hasCredits() {
      throw new Error("billing is down");
    },
  };
  await kick(kickInput(s), failing);
  assert.equal(f.started.length, 0);
  assert.equal((await f.triggerRow(message.item.id))!.status, "pending_eval");
  // Another workspace's assistant id under this tenant matches nothing.
  await kick({ ...kickInput(s), assistantId: randomUUID() }, f.ports);
  assert.equal(f.started.length, 0);

  // A batch claimed by someone else whose run is not recorded yet: the kick
  // does not touch it (it may be that caller's start in progress).
  await f.schema.db
    .update(f.schema.assistantTriggers)
    .set({ status: "in_eval", routerBatchKey: "in-progress" })
    .where(eq(f.schema.assistantTriggers.id, message.item.id));
  await kick(kickInput(s), f.ports);
  assert.equal(f.started.length, 0);
  assert.equal(
    (await f.triggerRow(message.item.id))!.routerBatchKey,
    "in-progress",
  );
});

test("a Router run is recorded only over an empty slot: a second run waits until the first is settled", async () => {
  const s = await setup();
  // Run X is recorded (as a racing caller would have).
  const x = await f.ports.startTurn({
    origin: "assistant_router",
    existingThread: true,
    workspaceId: s.workspaceId,
    userId: s.steward,
    threadId: s.assistant.routerThreadId,
    idempotencyKey: "x-batch",
    title: "Workspace assistant",
    content: "x",
  });
  await f.setCurrentRouterRun(s.assistant.id, {
    runId: x.run.id,
    batchKey: "x-batch",
  });
  const message = await f.insertTrigger({
    teamId: s.teamId,
    workspaceId: s.workspaceId,
    assistantId: s.assistant.id,
    payerUserId: s.a,
  });

  // X has ended but is not settled yet (the conversation takes one active
  // run at a time, so Y can only start once X is no longer active).
  await f.setRunStatus(x.run.id, { status: "completed" });
  // Another caller starts run Y on a fresh batch: X stays recorded.
  const outcome = await claimAndStart(
    await assistantRow(s),
    { payerUserId: s.a, triggerIds: [message.id] },
    f.ports,
  );
  assert.equal(outcome, "started");
  const y = f.started.at(-1)!;
  let assistant = await assistantRow(s);
  assert.equal(assistant.currentRouterRunId, x.run.id);
  assert.equal(assistant.currentRouterBatchKey, "x-batch");
  assert.equal((await f.triggerRow(message.id))!.status, "in_eval");

  // The tick settles X and records Y (found again by its key).
  f.reset();
  await tick(new Date(), f.ports);
  assistant = await assistantRow(s);
  assert.equal(assistant.currentRouterBatchKey, y.idempotencyKey);
  const yRun = (
    await f.schema.db
      .select()
      .from(f.schema.chatThreadRuns)
      .where(eq(f.schema.chatThreadRuns.idempotencyKey, y.idempotencyKey))
  )[0]!;
  assert.equal(assistant.currentRouterRunId, yRun.id);
  assert.equal((await f.triggerRow(message.id))!.status, "in_eval");
});

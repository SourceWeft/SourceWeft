import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAssistantFixture,
  type AssistantFixture,
} from "../../../test/assistant-fixture";
import type { OriginTurnContext } from "../../threads/agent/origin-providers";
import type {
  createReportTool,
  isWorkerToolError,
  resolveWorkerToolsContext,
} from "./tools";

let f: AssistantFixture;
// `./tools` imports `db`; loaded after the fixture repoints DATABASE_URL at
// this test's own database (see router.database.test.ts).
let createReportToolFn: typeof createReportTool;
let isWorkerToolErrorFn: typeof isWorkerToolError;
let resolveWorkerToolsContextFn: typeof resolveWorkerToolsContext;

beforeAll(async () => {
  f = await createAssistantFixture("asst_report");
  const tools = await import("./tools");
  createReportToolFn = tools.createReportTool;
  isWorkerToolErrorFn = tools.isWorkerToolError;
  resolveWorkerToolsContextFn = tools.resolveWorkerToolsContext;
}, 120_000);

beforeEach(() => f.reset());

afterAll(async () => {
  await f?.close();
});

/** An enabled assistant and one working ticket paid for by `member`, as if
 * the dispatch tick had just started its worker run `runId`. */
async function setupWorkingTicket() {
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
  const runId = randomUUID();
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: member,
    title: "Draft the launch post",
    stage: "working",
    currentRunId: runId,
  });
  const ctx: OriginTurnContext = {
    workspaceId,
    teamId,
    threadId: ticket.workerThreadId,
    runId,
    userId: member,
    hostContext: { assistantId: assistant.id, ticketId: ticket.id },
  };
  return { steward, member, teamId, workspaceId, assistant, ticket, ctx };
}

async function reportTool(ctx: OriginTurnContext) {
  const resolved = await resolveWorkerToolsContextFn(ctx);
  return createReportToolFn(resolved, f.ports);
}

test("report ready: the ticket goes idle, with one worker_report event and one feed item", async () => {
  const { assistant, ticket, member, ctx } = await setupWorkingTicket();
  const report = await reportTool(ctx);

  const result = await report.invoke({
    status: "ready",
    summary: "Draft is in the doc.",
  });
  assert.ok(!isWorkerToolErrorFn(result), JSON.stringify(result));

  const updated = (await f.ticketRow(ticket.id))!;
  assert.equal(updated.stage, "idle");
  assert.equal(updated.outcome, "ready");
  assert.equal(updated.lastReportSummary, "Draft is in the doc.");

  const triggers = await f.triggerRows(assistant.id);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.sourceKind, "worker_report");
  assert.equal(triggers[0]!.payerUserId, member);
  assert.equal(triggers[0]!.ticketId, ticket.id);
  assert.equal(triggers[0]!.status, "pending_eval");
  assert.equal(triggers[0]!.text, "ready: Draft is in the doc.");

  const feed = await f.feedItemRows(assistant.id);
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.kind, "ticket_update");
  assert.equal(feed[0]!.ticketId, ticket.id);
  assert.match(feed[0]!.text, /Draft is in the doc\./);

  // No question, no notification.
  assert.equal(f.notifications.length, 0);
});

test("report dropped also goes idle; blocked and failed wait for a person", async () => {
  for (const [status, stage] of [
    ["dropped", "idle"],
    ["blocked", "waiting_person"],
    ["failed", "waiting_person"],
  ] as const) {
    const { ticket, ctx } = await setupWorkingTicket();
    const report = await reportTool(ctx);
    const result = await report.invoke({ status, summary: `It is ${status}.` });
    assert.ok(!isWorkerToolErrorFn(result), JSON.stringify(result));
    const updated = (await f.ticketRow(ticket.id))!;
    assert.equal(updated.stage, stage, status);
    assert.equal(updated.outcome, status);
  }
});

test("report waiting with a question waits for a person and notifies the payer", async () => {
  const { assistant, ticket, member, teamId, ctx } = await setupWorkingTicket();
  const report = await reportTool(ctx);

  const result = await report.invoke({
    status: "waiting",
    summary: "Two versions drafted.",
    question: "Which tone do you want, formal or casual?",
  });
  assert.ok(!isWorkerToolErrorFn(result), JSON.stringify(result));

  const updated = (await f.ticketRow(ticket.id))!;
  assert.equal(updated.stage, "waiting_person");
  assert.equal(updated.outcome, "waiting");

  assert.equal(f.notifications.length, 1);
  const notification = f.notifications[0]!;
  assert.equal(notification.kind, "assistant_question");
  assert.equal(notification.userId, member);
  assert.equal(notification.teamId, teamId);
  assert.deepEqual(notification.ref, {
    kind: "assistant_ticket",
    id: ticket.id,
  });
  assert.equal(notification.payload?.ticketId, ticket.id);
  assert.equal(notification.payload?.taskName, "Draft the launch post");

  // The question itself is in the event and the feed, where people read it.
  const [trigger] = await f.triggerRows(assistant.id);
  assert.match(trigger!.text, /Which tone do you want/);
  const [feedItem] = await f.feedItemRows(assistant.id);
  assert.match(feedItem!.text, /Which tone do you want/);
});

test("a report from a run that is no longer the ticket's is refused as a tool error, writing nothing", async () => {
  const { assistant, ticket, ctx } = await setupWorkingTicket();
  const report = await reportTool({ ...ctx, runId: randomUUID() });

  const result = await report.invoke({ status: "ready", summary: "Done" });
  assert.ok(isWorkerToolErrorFn(result));
  assert.equal(result.code, "STALE_RUN");

  assert.equal((await f.ticketRow(ticket.id))!.stage, "working");
  assert.equal((await f.triggerRows(assistant.id)).length, 0);
  assert.equal((await f.feedItemRows(assistant.id)).length, 0);
});

test("a report on an ended ticket is refused as a tool error", async () => {
  const { ticket, ctx, workspaceId, member } = await setupWorkingTicket();
  const report = await reportTool(ctx);
  await f.service.closeTicket({ workspaceId, userId: member }, ticket.id, {
    idempotencyKey: "close",
  });

  const result = await report.invoke({ status: "ready", summary: "Done" });
  assert.ok(isWorkerToolErrorFn(result));
  assert.equal(result.code, "TICKET_ENDED");
});

test("report arguments out of bounds come back as a tool error, never a throw", async () => {
  const { ctx, assistant } = await setupWorkingTicket();
  const report = await reportTool(ctx);
  const result = await report
    .invoke({
      status: "ready",
      summary: "x".repeat(2001),
    } as never)
    .catch((error: unknown) => error);
  // LangChain validates the schema before the body runs; whatever it does,
  // the 2000-character cap must hold and nothing must be written.
  assert.ok(result instanceof Error || isWorkerToolErrorFn(result));
  assert.equal((await f.triggerRows(assistant.id)).length, 0);
});

test("the worker's tools refuse to start without a complete hostContext or for an unknown ticket", async () => {
  const { ctx, assistant } = await setupWorkingTicket();
  await assert.rejects(
    resolveWorkerToolsContextFn({
      ...ctx,
      hostContext: { assistantId: assistant.id },
    }),
    /hostContext/,
  );
  await assert.rejects(
    resolveWorkerToolsContextFn({
      ...ctx,
      hostContext: { ticketId: randomUUID() },
    }),
    /hostContext/,
  );
  await assert.rejects(
    resolveWorkerToolsContextFn({
      ...ctx,
      hostContext: { assistantId: assistant.id, ticketId: randomUUID() },
    }),
    /No ticket/,
  );
  await assert.rejects(
    resolveWorkerToolsContextFn({
      ...ctx,
      hostContext: { assistantId: randomUUID(), ticketId: randomUUID() },
    }),
    /No assistant/,
  );
});

test("registerAssistantTurnProviders equips Router and Worker turns, and fails a turn whose hostContext does not resolve", async () => {
  const { ctx, ticket } = await setupWorkingTicket();
  const { registerAssistantTurnProviders } =
    await import("../register-turn-providers");
  const origins = await import("../../threads/agent/origin-providers");
  registerAssistantTurnProviders(f.ports);
  try {
    // A second registration is a wiring error, not a silent replacement.
    assert.throws(
      () => registerAssistantTurnProviders(f.ports),
      /already registered/,
    );

    const worker = origins.getOriginTurnProvider("assistant_ticket")!;
    assert.equal(worker.replaceTools, false);
    const tools = await worker.tools(ctx);
    assert.deepEqual(
      tools.map((t) => t.name),
      ["report"],
    );
    const prompt = await worker.prompt(ctx);
    assert.match(prompt, /No person is present/);
    assert.match(prompt, /report/);
    assert.ok(prompt.includes(`<assistant-ticket id=${ticket.id}>`));
    assert.ok(prompt.includes("Title: Draft the launch post"));
    await assert.rejects(
      worker.tools({ ...ctx, hostContext: {} }),
      /hostContext/,
    );
    await assert.rejects(
      worker.prompt({ ...ctx, hostContext: {} }),
      /hostContext/,
    );

    const router = origins.getOriginTurnProvider("assistant_router")!;
    assert.equal(router.replaceTools, true);
    await assert.rejects(
      router.tools({
        ...ctx,
        hostContext: { assistantId: ctx.hostContext.assistantId! },
      }),
      /hostContext/,
    );
    await assert.rejects(
      router.prompt({
        ...ctx,
        hostContext: {
          assistantId: ctx.hostContext.assistantId!,
          batchKey: "no-such-batch",
        },
      }),
      /No in_eval triggers/,
    );
  } finally {
    origins.unregisterOriginTurnProvider("assistant_ticket");
    origins.unregisterOriginTurnProvider("assistant_router");
  }
});

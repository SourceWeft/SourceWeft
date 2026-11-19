import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  startThreadTurnRequestSchema,
  streamThreadRequestSchema,
} from "@sourceweft/contracts";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

// The queue is the only thing replaced: the conversation, the run row and the
// request the worker will read are the real ones.
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../content/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content/queue")>()),
  enqueueThreadChatRunJob: enqueue,
}));

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let service: typeof import("./service").contentThreadService;
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let owner: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("sched_turn");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ contentThreadService: service } = await import("./service"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Scheduled turn",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.workspaceMemberships)
    .values({ workspaceId, userId: owner, role: "editor", source: "guest" });
  enqueue.mockReset();
  enqueue.mockImplementation(async (payload: { runId: string }) => ({
    id: `job-${payload.runId}`,
  }));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function turn(overrides: Record<string, unknown> = {}) {
  const slot = randomUUID();
  return {
    workspaceId,
    userId: owner,
    threadId: randomUUID(),
    idempotencyKey: `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}scheduled:${slot}`,
    title: "Morning digest · 2026-11-18",
    content: "Summarize what is new",
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

async function runs() {
  return schema.db
    .select()
    .from(schema.chatThreadRuns)
    .where(eq(schema.chatThreadRuns.workspaceId, workspaceId));
}

test("a scheduled turn is an ordinary queued chat run in a new conversation of the owner, marked unattended", async () => {
  const input = turn();
  const { thread, run, created } = await service.startScheduledTurn(input);

  assert.equal(created, true);
  assert.equal(thread.id, input.threadId);
  assert.equal(thread.origin, "scheduled");
  assert.equal(thread.createdBy, owner);
  assert.equal(thread.title, "Morning digest · 2026-11-18");
  assert.equal(thread.visibility, "private");
  assert.equal(thread.teamId, teamId);

  assert.equal(run.threadId, thread.id);
  assert.equal(run.userId, owner);
  assert.equal(run.mode, "send");
  assert.equal(run.status, "queued");
  assert.equal(run.idempotencyKey, input.idempotencyKey);
  assert.equal(run.jobId, `job-${run.id}`);
  // What the worker reads back to run the turn.
  assert.deepEqual(run.requestJson, {
    workspaceId,
    threadId: thread.id,
    userId: owner,
    content: "Summarize what is new",
    timezone: "Asia/Shanghai",
    idempotencyKey: input.idempotencyKey,
    unattended: true,
    mode: "send",
  });
  // The same job a person's turn gets, only behind theirs in the queue.
  assert.deepEqual(enqueue.mock.calls, [
    [
      {
        runId: run.id,
        teamId,
        workspaceId,
        threadId: thread.id,
        userId: owner,
      },
      { priority: 10 },
    ],
  ]);
});

test("starting the same scheduled turn again returns the same conversation and run", async () => {
  const input = turn();
  const first = await service.startScheduledTurn(input);
  const second = await service.startScheduledTurn(input);
  const [third, fourth] = await Promise.all([
    service.startScheduledTurn(input),
    service.startScheduledTurn(input),
  ]);

  for (const again of [second, third, fourth]) {
    assert.equal(again.created, false);
    assert.equal(again.thread.id, first.thread.id);
    assert.equal(again.run.id, first.run.id);
  }
  assert.equal((await runs()).length, 1);
  assert.equal(enqueue.mock.calls.length, 1);
});

test("a run that never reached the queue is started again in the same conversation", async () => {
  const input = turn();
  enqueue.mockRejectedValueOnce(new Error("queue down"));
  await assert.rejects(service.startScheduledTurn(input), /queue down/);
  const [dead] = await runs();
  assert.deepEqual(
    [dead!.status, dead!.errorCode],
    ["failed", "CHAT_RUN_START_FAILED"],
  );

  // The slot's retry: same ids, and this time the queue is there.
  const retried = await service.startScheduledTurn(input);
  assert.equal(retried.created, true);
  assert.equal(retried.thread.id, input.threadId);
  assert.notEqual(retried.run.id, dead!.id);
  assert.equal(retried.run.status, "queued");
  assert.equal(retried.run.idempotencyKey, `${input.idempotencyKey}:retry-1`);
  // And a replay of that retry finds it instead of making a third.
  const replayed = await service.startScheduledTurn(input);
  assert.equal(replayed.run.id, retried.run.id);
  assert.equal(replayed.created, false);

  assert.equal((await runs()).length, 2);
  const threads = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.workspaceId, workspaceId));
  assert.deepEqual(
    threads.map((thread) => thread.id),
    [input.threadId],
  );
});

test("sources that are gone are left out of the conversation's selection instead of failing the start", async () => {
  const input = turn({ sourceIds: [randomUUID(), randomUUID()] });
  const { thread } = await service.startScheduledTurn(input);
  const [row] = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, thread.id));
  assert.deepEqual(row!.sourceSelectionJson, {
    revision: 1,
    selectedSourceIds: [],
  });
});

test("a scheduled turn cannot be started as someone who is not in the workspace, or into another person's conversation", async () => {
  await assert.rejects(
    service.startScheduledTurn(turn({ userId: randomUUID() })),
    (error: { code?: string }) => error.code === "WORKSPACE_NOT_FOUND",
  );

  const colleague = randomUUID();
  await schema.db.insert(schema.workspaceMemberships).values({
    workspaceId,
    userId: colleague,
    role: "editor",
    source: "guest",
  });
  const mine = await service.startScheduledTurn(turn());
  // Same conversation id, different person and a fresh key.
  await assert.rejects(
    service.startScheduledTurn(
      turn({ userId: colleague, threadId: mine.thread.id }),
    ),
  );
  assert.equal((await runs()).length, 1);
  assert.equal(enqueue.mock.calls.length, 1);
});

test("no HTTP request can mark its own turn unattended", () => {
  const body = { content: "hi", unattended: true };
  assert.equal("unattended" in streamThreadRequestSchema.parse(body), false);
  assert.equal(
    "unattended" in
      startThreadTurnRequestSchema.parse({
        ...body,
        idempotencyKey: `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}x`,
      }),
    false,
  );
});

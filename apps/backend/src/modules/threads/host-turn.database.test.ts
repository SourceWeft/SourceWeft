import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX } from "@sourceweft/contracts";
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
let startHostTurn: typeof import("./service").startHostTurn;
let durableChatRunService: typeof import("./durable/service").durableChatRunService;
let prepareThreadTurn: typeof import("./turn/preparer").prepareThreadTurn;
let repository: typeof import("./thread/repository");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let steward: string;
let colleague: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("host_turn");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  ({ startHostTurn } = await import("./service"));
  repository = await import("./thread/repository");
  ({ durableChatRunService } = await import("./durable/service"));
  ({ prepareThreadTurn } = await import("./turn/preparer"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, steward, colleague] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Host turn",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: steward, role: "editor", source: "guest" },
    { workspaceId, userId: colleague, role: "editor", source: "guest" },
  ]);
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

function key() {
  return `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}assistant:${randomUUID()}`;
}

async function runs() {
  return schema.db
    .select()
    .from(schema.chatThreadRuns)
    .where(eq(schema.chatThreadRuns.workspaceId, workspaceId));
}

/** The Router conversation, as the assistant creates it before its first run. */
async function routerThread(
  overrides: Partial<Parameters<typeof repository.createThreadRecord>[0]> = {},
) {
  return repository.createThreadRecord({
    id: randomUUID(),
    teamId,
    workspaceId,
    title: "Workspace assistant",
    createdBy: steward,
    visibility: "workspace",
    origin: "assistant_router",
    ...overrides,
  });
}

test("a ticket turn is a shared conversation whose queued run is unattended, capped and carries the host context", async () => {
  const input = {
    workspaceId,
    userId: colleague,
    threadId: randomUUID(),
    idempotencyKey: key(),
    title: "Ticket · triage the inbox",
    content: "Work the ticket",
    origin: "assistant_ticket" as const,
    visibility: "workspace" as const,
    creditCap: 50,
    jobPriority: 20,
    hostContext: { ticketId: "ticket_1" },
  };
  const { thread, run, created } = await startHostTurn(input);

  assert.equal(created, true);
  assert.equal(thread.id, input.threadId);
  assert.equal(thread.origin, "assistant_ticket");
  assert.equal(thread.visibility, "workspace");
  assert.equal(thread.createdBy, colleague);
  assert.equal(run.status, "queued");
  assert.deepEqual(run.requestJson, {
    workspaceId,
    threadId: thread.id,
    userId: colleague,
    content: "Work the ticket",
    idempotencyKey: input.idempotencyKey,
    unattended: true,
    creditCap: 50,
    hostContext: { ticketId: "ticket_1" },
    mode: "send",
  });
  assert.deepEqual(enqueue.mock.calls.at(-1)?.[1], { priority: 20 });
});

test("the Router conversation is reused: another member starting the next run is not refused", async () => {
  const router = await routerThread();

  const first = await startHostTurn({
    workspaceId,
    userId: steward,
    threadId: router.id,
    idempotencyKey: key(),
    title: "ignored",
    content: "batch 1",
    origin: "assistant_router",
    existingThread: true,
  });
  // A conversation runs one turn at a time: the host starts the next batch
  // once the previous run is over.
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(schema.chatThreadRuns.id, first.run.id));
  const second = await startHostTurn({
    workspaceId,
    userId: colleague,
    threadId: router.id,
    idempotencyKey: key(),
    title: "ignored",
    content: "batch 2",
    origin: "assistant_router",
    existingThread: true,
  });

  for (const started of [first, second]) {
    assert.equal(started.created, true);
    assert.equal(started.thread.id, router.id);
  }
  assert.notEqual(first.run.id, second.run.id);
  assert.equal(second.run.userId, colleague);
  // An existing conversation keeps its title and visibility.
  const [row] = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, router.id));
  assert.equal(row!.title, "Workspace assistant");
  assert.equal(row!.visibility, "workspace");
  assert.equal((await runs()).length, 2);

  // Why the Router start reuses instead of creating: thread creation only
  // finds an existing conversation of the same creator.
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(schema.chatThreadRuns.id, second.run.id));
  await assert.rejects(
    startHostTurn({
      workspaceId,
      userId: colleague,
      threadId: router.id,
      idempotencyKey: key(),
      title: "ignored",
      content: "batch 3",
      origin: "assistant_router",
    }),
  );
});

test("an existing-thread start only reaches a conversation of that origin the member can see", async () => {
  const notFound = (error: { statusCode?: number; code?: string }) =>
    error.statusCode === 404 && error.code === "THREAD_NOT_FOUND";
  const start = (threadId: string) =>
    startHostTurn({
      workspaceId,
      userId: colleague,
      threadId,
      idempotencyKey: key(),
      title: "ignored",
      content: "batch",
      origin: "assistant_router",
      existingThread: true,
    });

  await assert.rejects(start(randomUUID()), notFound);
  // Somebody's ordinary conversation is not a Router conversation.
  const ordinary = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Mine",
    createdBy: colleague,
  });
  await assert.rejects(start(ordinary.id), notFound);
  // A private Router conversation of another member is not visible.
  const hidden = await routerThread({ visibility: "private" });
  await assert.rejects(start(hidden.id), notFound);
  assert.equal((await runs()).length, 0);
});

test("the chat list leaves out the Router conversation and keeps ticket conversations", async () => {
  const router = await routerThread();
  const ticket = await startHostTurn({
    workspaceId,
    userId: steward,
    threadId: randomUUID(),
    idempotencyKey: key(),
    title: "Ticket",
    content: "Work the ticket",
    origin: "assistant_ticket",
    visibility: "workspace",
  });

  for (const viewer of [steward, colleague]) {
    const listed = await repository.listThreadRecordsByWorkspace({
      teamId,
      workspaceId,
      viewerUserId: viewer,
      limit: 50,
    });
    const ids = listed.map((thread) => thread.id);
    assert.equal(ids.includes(router.id), false, viewer);
    assert.ok(ids.includes(ticket.thread.id), viewer);
  }
});

test("host context larger than 1 KB is refused before anything is created", async () => {
  const threadId = randomUUID();
  await assert.rejects(
    startHostTurn({
      workspaceId,
      userId: steward,
      threadId,
      idempotencyKey: key(),
      title: "Ticket",
      content: "Work the ticket",
      origin: "assistant_ticket",
      hostContext: { blob: "x".repeat(1024) },
    }),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 400 && error.code === "HOST_CONTEXT_TOO_LARGE",
  );
  const threads = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  assert.equal(threads.length, 0);
  assert.equal((await runs()).length, 0);
});

test("a member's own turn into an assistant conversation is refused on every path; the host's still starts", async () => {
  const hostOwned = (error: { statusCode?: number; code?: string }) =>
    error.statusCode === 403 && error.code === "THREAD_HOST_OWNED";
  const router = await routerThread();
  const ticket = await startHostTurn({
    workspaceId,
    userId: steward,
    threadId: randomUUID(),
    idempotencyKey: key(),
    title: "Ticket",
    content: "Work the ticket",
    origin: "assistant_ticket",
    visibility: "workspace",
  });
  const runsBefore = (await runs()).length;

  for (const threadId of [router.id, ticket.thread.id]) {
    for (const userId of [steward, colleague]) {
      // Durable entry shared by send, edit, regenerate and resume.
      for (const mode of ["send", "edit", "refresh", "resume"] as const) {
        const idempotencyKey = key();
        await assert.rejects(
          durableChatRunService.getOrCreateRun({
            workspaceId,
            threadId,
            userId,
            idempotencyKey,
            mode,
            request: {
              workspaceId,
              threadId,
              userId,
              content: "hello",
              idempotencyKey,
            },
          }),
          hostOwned,
          `${mode} ${threadId}`,
        );
      }
      // The turn preparer every turn passes, durable or direct.
      await assert.rejects(
        prepareThreadTurn({
          workspaceId,
          threadId,
          userId,
          content: "hello",
          idempotencyKey: key(),
        }),
        hostOwned,
      );
    }
  }
  assert.equal((await runs()).length, runsBefore);
  assert.equal(enqueue.mock.calls.length, 1);

  // The ticket's own run is over; the host starts the next one.
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(schema.chatThreadRuns.id, ticket.run.id));
  const next = await startHostTurn({
    workspaceId,
    userId: colleague,
    threadId: router.id,
    idempotencyKey: key(),
    title: "ignored",
    content: "batch",
    origin: "assistant_router",
    existingThread: true,
  });
  assert.equal(next.created, true);
});

test("a member's turn into an ordinary conversation still starts", async () => {
  const mine = await repository.createThreadRecord({
    teamId,
    workspaceId,
    title: "Mine",
    createdBy: colleague,
  });
  const idempotencyKey = key();
  const { created } = await durableChatRunService.getOrCreateRun({
    workspaceId,
    threadId: mine.id,
    userId: colleague,
    idempotencyKey,
    mode: "send",
    request: {
      workspaceId,
      threadId: mine.id,
      userId: colleague,
      content: "hello",
      idempotencyKey,
    },
  });
  assert.equal(created, true);
});

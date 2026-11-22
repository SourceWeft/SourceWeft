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

// The run insert is wrapped so a test can line two starts up at it: by
// default it is the real insert, untouched.
type CreateRun = typeof import("./durable/repository").createChatThreadRun;
const createRunHook = vi.hoisted(() => ({
  current: null as
    | null
    | ((real: CreateRun, input: Parameters<CreateRun>[0]) => ReturnType<CreateRun>),
}));
vi.mock("./durable/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./durable/repository")>();
  return {
    ...actual,
    createChatThreadRun: (input: Parameters<CreateRun>[0]) =>
      createRunHook.current
        ? createRunHook.current(actual.createChatThreadRun, input)
        : actual.createChatThreadRun(input),
  };
});

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
  createRunHook.current = null;
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

// ── Two starts of the same turn at once (a kick racing the tick) ─────────

/**
 * Holds every run insert until `arrivals` starts have reached it, so each has
 * already passed its own "is there a run for this key?" lookup. Then
 * `release` decides what each one does, by arrival order.
 */
function lineUpInserts(
  arrivals: number,
  release: (
    real: CreateRun,
    input: Parameters<CreateRun>[0],
    order: number,
    earlier: Promise<unknown>[],
  ) => ReturnType<CreateRun>,
) {
  const inserts: Promise<unknown>[] = [];
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  createRunHook.current = async (real, input) => {
    const order = arrived;
    arrived += 1;
    if (arrived === arrivals) open();
    await gate;
    const earlier = inserts.slice(0, order);
    const insert = release(real, input, order, earlier);
    inserts[order] = insert.catch(() => undefined);
    return insert;
  };
}

async function routerStart(threadId: string, idempotencyKey: string) {
  return startHostTurn({
    workspaceId,
    userId: steward,
    threadId,
    idempotencyKey,
    title: "ignored",
    content: "batch",
    origin: "assistant_router",
    existingThread: true,
  });
}

test("two starts of the same turn that both reach the insert: the loser's violation is a replay of the winner's run", async () => {
  const router = await routerThread();
  const idempotencyKey = key();
  // What the second insert meets when the first lands between its lookup and
  // its own insert: the conversation's one-active-run index, raised by
  // PostgreSQL through drizzle. Reproduced for real by a second insert into
  // the same conversation once the first has committed.
  lineUpInserts(2, async (real, input, order, earlier) => {
    if (order === 0) return real(input);
    await Promise.all(earlier);
    return real({ ...input, idempotencyKey: `${input.idempotencyKey}:loser` });
  });

  const [first, second] = await Promise.all([
    routerStart(router.id, idempotencyKey),
    routerStart(router.id, idempotencyKey),
  ]);

  assert.deepEqual(
    [first.created, second.created].sort(),
    [false, true],
  );
  assert.equal(first.run.id, second.run.id);
  assert.equal(first.thread.id, router.id);
  assert.equal(second.thread.id, router.id);
  const all = await runs();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.idempotencyKey, idempotencyKey);
  assert.equal(enqueue.mock.calls.length, 1);
});

test("two starts of the same turn released at the same instant: both resolve to one run, whatever PostgreSQL raises", async () => {
  for (let round = 0; round < 10; round += 1) {
    const router = await routerThread();
    const idempotencyKey = key();
    lineUpInserts(2, (real, input) => real(input));
    const [first, second] = await Promise.all([
      routerStart(router.id, idempotencyKey),
      routerStart(router.id, idempotencyKey),
    ]);
    assert.deepEqual([first.created, second.created].sort(), [false, true], `round ${round}`);
    assert.equal(first.run.id, second.run.id, `round ${round}`);
    const forKey = (await runs()).filter((run) => run.idempotencyKey === idempotencyKey);
    assert.equal(forKey.length, 1, `round ${round}`);
  }
});

test("a new conversation started twice at once: one conversation, one run", async () => {
  const input = {
    workspaceId,
    userId: steward,
    threadId: randomUUID(),
    idempotencyKey: key(),
    title: "Ticket",
    content: "Work the ticket",
    origin: "assistant_ticket" as const,
    visibility: "workspace" as const,
  };
  lineUpInserts(2, async (real, run, order, earlier) => {
    if (order === 0) return real(run);
    await Promise.all(earlier);
    return real({ ...run, idempotencyKey: `${run.idempotencyKey}:loser` });
  });

  const [first, second] = await Promise.all([startHostTurn(input), startHostTurn(input)]);

  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(first.run.id, second.run.id);
  const threads = await schema.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.workspaceId, workspaceId));
  assert.deepEqual(threads.map((thread) => thread.id), [input.threadId]);
  assert.equal((await runs()).length, 1);
});

test("a run of another key holding the conversation is still a 409, not a replay", async () => {
  const router = await routerThread();
  const active = await routerStart(router.id, key());
  assert.equal(active.created, true);
  // Both lookups pass; the other key's run is what the insert meets.
  const idempotencyKey = key();
  await assert.rejects(
    routerStart(router.id, idempotencyKey),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 409 && error.code === "CHAT_RUN_ALREADY_ACTIVE",
  );
  // And when the insert itself is what meets it (the active run landed after
  // the lookups): still a 409, never a raw database error.
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(schema.chatThreadRuns.id, active.run.id));
  const other = key();
  createRunHook.current = async (real, input) => {
    createRunHook.current = null;
    await real({ ...input, idempotencyKey: other });
    return real(input);
  };
  await assert.rejects(
    routerStart(router.id, idempotencyKey),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 409 && error.code === "CHAT_RUN_ALREADY_ACTIVE",
  );
  assert.equal(
    (await runs()).filter((run) => run.idempotencyKey === idempotencyKey).length,
    0,
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let service: typeof import("./service").durableChatRunService;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
let owner: string;
let viewer: string;
let sequence: number;
let baseTime: number;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("latest_failure");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  ({ durableChatRunService: service } = await import("./service"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId, owner, viewer] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  sequence = 0;
  baseTime = Date.now() - 1000;
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Early failure",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: viewer, role: "viewer", source: "guest" },
  ]);
  await schema.db.insert(schema.threads).values({
    id: threadId,
    workspaceId,
    teamId,
    title: "Early failure",
    createdBy: owner,
    visibility: "workspace",
  });
});

afterEach(async () => {
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function createRun() {
  const run = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: owner,
    idempotencyKey: randomUUID(),
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: owner,
      content: "test",
    },
  });
  assert.ok(run);
  // Deterministic order without depending on timestamp resolution or UUID order.
  await schema.db
    .update(schema.chatThreadRuns)
    .set({
      createdAt: new Date(baseTime + ++sequence),
    })
    .where(eq(schema.chatThreadRuns.id, run.id));
  return run;
}

async function fail(
  runId: string,
  assistantMessageId?: string,
  errorMessage = "Image model is unavailable",
) {
  await repository.finishChatThreadRun({
    runId,
    teamId,
    workspaceId,
    status: "failed",
    assistantMessageId,
    errorCode: "MODEL_CONFIG_MISSING",
    errorMessage,
  });
}
const read = (userId = owner, scope = workspaceId) =>
  service.findLatestMessageLessFailure({
    workspaceId: scope,
    threadId,
    userId,
  });

test("a message-less failure remains visible without manufacturing message records", async () => {
  const run = await createRun();
  await fail(run.id);
  assert.deepEqual(await read(), {
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    errorCode: "MODEL_CONFIG_MISSING",
    errorMessage: "Image model is unavailable",
  });
  assert.equal(
    (await schema.database.query("select count(*) from messages")).rows[0]
      .count,
    "0",
  );
  assert.deepEqual(await read(viewer), await read());
});

test("the latest run controls the summary: active, success, or rendered failure clears an older error", async () => {
  const early = await createRun();
  await fail(early.id);
  const next = await createRun();
  assert.equal(await read(), null);
  await repository.markChatThreadRunRunning({
    runId: next.id,
    teamId,
    workspaceId,
  });
  await repository.finishChatThreadRun({
    runId: next.id,
    teamId,
    workspaceId,
    status: "completed",
  });
  assert.equal(await read(), null);
  const rendered = await createRun();
  const assistantId = randomUUID();
  await schema.db.insert(schema.messages).values({
    id: assistantId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "Existing error",
  });
  await fail(rendered.id, assistantId);
  assert.equal(await read(), null);
});

test("failure summaries recheck private thread visibility and live workspace membership", async () => {
  const run = await createRun();
  await fail(run.id);
  await schema.db
    .update(schema.threads)
    .set({ visibility: "private" })
    .where(eq(schema.threads.id, threadId));
  assert.equal(await read(viewer), null);
  assert.equal((await read())?.id, run.id);
  await assert.rejects(read(owner, randomUUID()), /Workspace not found/);
  await schema.db
    .delete(schema.workspaceMemberships)
    .where(eq(schema.workspaceMemberships.userId, owner));
  await assert.rejects(read(), /Workspace not found/);
});

test("a stored database exception is not exposed as SQL or parameters in the new summary", async () => {
  const run = await createRun();
  await fail(
    run.id,
    undefined,
    "Failed query: insert into messages (...)\nparams: private-request-value",
  );
  assert.equal(
    (await read())?.errorMessage,
    "The request could not be saved. Please try again.",
  );
});

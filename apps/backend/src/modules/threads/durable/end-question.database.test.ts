import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let messagesRepo: typeof import("../message-repository");
let endQuestion: typeof import("./end-question");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
let owner: string;
let member: string;
let runId: string;
let assistantMessageId: string;

const QUESTION = {
  type: "user_question_request",
  schemaVersion: 1,
  id: "question-1",
  toolCallId: "call-ask",
  questions: [
    {
      question: "Cats or dogs?",
      type: "multiple_choice",
      choices: [{ label: "Cats" }, { label: "Dogs" }],
    },
  ],
};

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("end_question");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  messagesRepo = await import("../message-repository");
  endQuestion = await import("./end-question");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId, owner, member] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "End question",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: member, role: "editor", source: "guest" },
  ]);
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, workspaceId, teamId, title: "End question" });
  const message = await messagesRepo.createMessageRecord({
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    createdBy: null,
    metadata: {
      finishReason: "user_question_requested",
      toolCalls: [
        {
          id: "call-ask",
          tool: "askUser",
          input: { questions: QUESTION.questions },
          output: QUESTION,
          status: "approval_requested",
          latencyMs: 0,
          error: null,
          sequence: 1,
        },
      ],
    },
  });
  assistantMessageId = message.id;
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
      content: "cats or dogs?",
    },
  });
  assert.ok(run);
  runId = run.id;
  // A question pause leaves its run completed, bound to the parked message.
  await schema.database.query(
    "update chat_thread_runs set status = 'completed', assistant_message_id = $2, finished_at = now() where id = $1",
    [runId, assistantMessageId],
  );
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

const input = (userId = owner) => ({
  workspaceId,
  threadId,
  userId,
  threadRunId: runId,
  assistantMessageId,
});

test("the run's owner ends a waiting question: recorded unanswered and the turn stopped", async () => {
  assert.deepEqual(await endQuestion.endPendingQuestions(input()), {
    ended: true,
  });

  const message = await messagesRepo.findMessageRecord({
    teamId,
    workspaceId,
    messageId: assistantMessageId,
  });
  const metadata = message!.metadata as Record<string, unknown>;
  assert.equal(metadata.isCancelled, true);
  assert.equal(metadata.errorCode, "CLIENT_CANCELLED");
  const [call] = metadata.toolCalls as Array<Record<string, unknown>>;
  assert.equal(call!.status, "completed");
  assert.equal(call!.output, "Q: Cats or dogs?\nA: (cancelled)");

  // Ending it again is a no-op; the run itself is untouched.
  assert.deepEqual(await endQuestion.endPendingQuestions(input()), {
    ended: false,
  });
  const run = await repository.findChatThreadRunById({ runId });
  assert.equal(run?.status, "completed");
});

test("another member cannot end someone else's question", async () => {
  await assert.rejects(endQuestion.endPendingQuestions(input(member)), {
    code: "CHAT_RUN_NOT_FOUND",
  });
});

test("a question cannot be ended while a run is active on the thread", async () => {
  const active = await repository.createChatThreadRun({
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
      content: "and now?",
    },
  });
  assert.ok(active);
  await assert.rejects(endQuestion.endPendingQuestions(input()), {
    code: "CHAT_RUN_ALREADY_ACTIVE",
  });
});

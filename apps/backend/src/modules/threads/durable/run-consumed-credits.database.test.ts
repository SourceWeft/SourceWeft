import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ContentError } from "../../content/errors";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ChatThreadRunRecord } from "./types";

/**
 * Generic threads-module coverage for Task 3: a run's `consumed_credits`
 * always ends up set once the run finishes, whether it completes normally
 * (summed from the finalizer's settled model calls) or fails partway through
 * (the calls settled before the failure). This module knows nothing about
 * tickets or assistants; it only proves the number lands on the row.
 */

const mocked = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../stream/service", () => ({
  ContentThreadStreamService: class {
    streamThreadEvents(...args: unknown[]) {
      return mocked.stream(...args);
    }
  },
}));

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let runner: typeof import("./runner");
let streams: typeof import("./stream-manager");
let messages: typeof import("../message-repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let run: ChatThreadRunRecord;
let workspaceId: string;
let threadId: string;
let teamId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("run_credits");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  runner = await import("./runner");
  streams = await import("./stream-manager");
  messages = await import("../message-repository");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Consumed credits test",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, workspaceId, teamId, title: "Consumed credits test" });
  const created = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "test-user",
    idempotencyKey: randomUUID(),
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "test-user",
      content: "query",
    },
  });
  assert.ok(created);
  run = created;
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
  vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockResolvedValue(1);
});

afterEach(async () => {
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
  mocked.stream.mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const jobPayload = () => ({
  runId: run.id,
  teamId,
  workspaceId,
  threadId,
  userId: "test-user",
});

function preparedTurn(overrides: Record<string, unknown> = {}) {
  return {
    workspace: { id: workspaceId, organizationId: teamId },
    thread: { id: threadId },
    userId: "test-user",
    runTraceId: run.id,
    reasoningRun: { runId: run.id, parentRunId: null, base: "" },
    modelAlias: "synthetic-chat",
    profileAlias: "synthetic-chat",
    preflightThinkingSteps: [],
    preflightBilling: [],
    failurePersistence: "persist-error-turn",
    ...overrides,
  };
}

test("a run that settles three model calls records their summed credits on completion", async () => {
  let assistantId: string | undefined;
  mocked.stream.mockImplementation(async function* (_request, options) {
    const userMessage = await messages.createMessageRecord({
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "question",
      createdBy: null,
    });
    const placeholder = await options.onPrepared(
      preparedTurn({ userMessage }),
    );
    assistantId = placeholder.assistantMessageId;
    yield `data: ${JSON.stringify({ type: "text-delta", delta: "answer" })}\n\n`;
    const calls = [0, 1, 2].map((index) => ({
      id: `settled:${run.id}:${index}`,
      consumedCredits: 2,
      billingStatus: "metered",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const committed = await messages.updateMessageRecord({
      teamId,
      workspaceId,
      threadId,
      messageId: assistantId!,
      creditsConsumed: 6,
      metadata: {
        meteredLlmCalls: calls,
        meteredLlmCreditsConsumed: 6,
        billingSkipped: false,
        finishReason: "stop",
      },
    });
    await options.onFinalized({
      assistantMessage: committed,
      billing: {
        teamId,
        consumedCredits: 6,
        availableCredits: 994,
        consumedThisCycle: 6,
        idempotencyReplayed: false,
      },
    });
    yield 'data: {"type":"text-end"}\n\n';
    yield `data: ${JSON.stringify({ type: "assistant-message", messageId: assistantId })}\n\n`;
    yield 'data: {"type":"finish","finishReason":"stop"}\n\n';
  });

  const result = await runner.processThreadChatRunJob(jobPayload());

  assert.equal(result.status, "completed");
  const stored = await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(stored?.consumedCredits, 6);
});

test("a run that settles once and then fails records only what was settled", async () => {
  mocked.stream.mockImplementation(async function* (_request, options) {
    const userMessage = await messages.createMessageRecord({
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "question",
      createdBy: null,
    });
    const prepared = preparedTurn({ userMessage });
    const placeholder = await options.onPrepared(prepared);
    const contentError = new ContentError(
      502,
      "MODEL_UPSTREAM_ERROR",
      "model call failed after one settlement",
    );
    await options.createErrorMessage({
      prepared: { ...prepared, assistantMessageId: placeholder.assistantMessageId },
      contentError,
      partialState: {
        meteredLlmCalls: [
          {
            id: `settled:${run.id}:0`,
            consumedCredits: 2,
            billingStatus: "metered",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    });
    yield `data: ${JSON.stringify({ type: "error", code: contentError.code, error: contentError.message })}\n\n`;
  });

  const result = await runner.processThreadChatRunJob(jobPayload());

  assert.equal(result.status, "failed");
  const stored = await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(stored?.consumedCredits, 2);
});

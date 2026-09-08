import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ChatThreadRunRecord } from "./types";

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
let recovery: typeof import("./run-recovery");
let service: typeof import("./service");
let runner: typeof import("./runner");
let streams: typeof import("./stream-manager");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let run: ChatThreadRunRecord;
let workspaceId: string;
let threadId: string;
let teamId: string;
let released: string[];
let emitted: string[];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("run_terminal");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  recovery = await import("./run-recovery");
  service = await import("./service");
  runner = await import("./runner");
  streams = await import("./stream-manager");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId] = [randomUUID(), randomUUID(), randomUUID()];
  released = [];
  emitted = [];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Terminal race test",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, workspaceId, teamId, title: "Terminal race test" });
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
});

afterEach(async () => {
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
  mocked.stream.mockReset();
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const scope = () => ({ runId: run.id, teamId, workspaceId });
const current = () => repository.findChatThreadRunById(scope());
async function staleRunning() {
  await repository.markChatThreadRunRunning(scope());
  await schema.database.query(
    "update chat_thread_runs set heartbeat_at = now() - interval '11 minutes' where id = $1",
    [run.id],
  );
  run = (await current())!;
}
function recover(
  options: Partial<
    Parameters<typeof recovery.failStaleActiveRunWithDependencies>[1]
  > = {},
) {
  return recovery.failStaleActiveRunWithDependencies(run, {
    appendEvent: async (_key, event) => {
      const stored = await current();
      assert.equal(
        stored?.status,
        "failed",
        "SSE may only describe a committed terminal row",
      );
      emitted.push(event);
      return emitted.length;
    },
    releaseLease: async (finished) => {
      assert.equal((await current())?.status, "failed");
      released.push(finished.id);
    },
    updateAssistantMetadata: async () => null,
    ...options,
  });
}
async function lockRun() {
  const connection = await schema.database.connect();
  await connection.query("begin");
  await connection.query(
    "select id from chat_thread_runs where id = $1 for update",
    [run.id],
  );
  return connection;
}
async function waitForLockWait(count = 1) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await schema.database.query(
      "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%chat_thread_runs%'",
    );
    if (Number(waiting.rows[0]?.count) >= count) return;
    await delay(10);
  }
  throw new Error(
    "Expected durable repository transaction to wait for the real run row lock",
  );
}

test("heartbeat committed while recovery waits prevents stale terminal events and lease release", async () => {
  await staleRunning();
  const connection = await lockRun();
  const recovering = recover();
  try {
    await waitForLockWait();
    await connection.query(
      "update chat_thread_runs set heartbeat_at = now() where id = $1",
      [run.id],
    );
    await connection.query("commit");
    assert.equal((await recovering)?.status, "running");
    assert.equal((await current())?.status, "running");
    assert.deepEqual(emitted, []);
    assert.deepEqual(released, []);
  } finally {
    await connection.query("rollback");
    connection.release();
    await recovering;
  }
});

test("normal completion committed while recovery waits wins without stale events or release", async () => {
  await staleRunning();
  const connection = await lockRun();
  const completing = repository.finishChatThreadRun({
    ...scope(),
    status: "completed",
  });
  await waitForLockWait();
  const recovering = recover();
  try {
    await waitForLockWait(2);
    await connection.query("commit");
    assert.equal((await completing)?.status, "completed");
    assert.equal((await recovering)?.status, "completed");
    assert.deepEqual(emitted, []);
    assert.deepEqual(released, []);
  } finally {
    await connection.query("rollback");
    connection.release();
    await Promise.all([completing, recovering]);
  }
});

test("stale recovery wins once and fences a waiting heartbeat and completion", async () => {
  await staleRunning();
  const connection = await lockRun();
  const recovering = recover();
  await waitForLockWait();
  const completing = repository.finishChatThreadRun({
    ...scope(),
    status: "completed",
  });
  const heartbeat = repository.touchChatThreadRunHeartbeat(scope());
  try {
    await waitForLockWait(3);
    await connection.query("commit");
    assert.equal((await recovering)?.errorCode, "CHAT_RUN_STALE");
    assert.equal(await completing, null);
    assert.equal(await heartbeat, null);
    assert.deepEqual(
      emitted.map((value) => JSON.parse(value.slice(6)).type),
      ["error", "finish"],
    );
    assert.equal(released.length, 1);
    await recover();
    assert.equal(emitted.length, 2);
    assert.equal(released.length, 1);
  } finally {
    await connection.query("rollback");
    connection.release();
    await Promise.all([recovering, completing, heartbeat]);
  }
});

test("Redis terminal write failure leaves durable failure and attach reconstructs error plus finish", async () => {
  await staleRunning();
  const failure = new Error("Redis write unavailable");
  await assert.rejects(
    recover({
      appendEvent: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal((await current())?.errorCode, "CHAT_RUN_STALE");
  assert.equal(released.length, 1);
  const attached = await service.testExports.resolveAttachRunState({
    run,
    offset: 0,
    sawErrorEvent: false,
    getEvents: async () => ({ events: [], nextOffset: 0 }),
  });
  const events = attached.terminalEvents!.map((value) =>
    JSON.parse(value.slice(6)),
  );
  assert.equal(events[0]?.code, "CHAT_RUN_STALE");
  assert.deepEqual(
    events.map((event) => event.type),
    ["error", "finish"],
  );
});

test("cancel completion wins the run row lock before a late artifact publication", async () => {
  await repository.markChatThreadRunRunning(scope());
  const connection = await lockRun();
  const cancelling = repository.finishChatThreadRun({
    ...scope(),
    status: "cancelled",
    errorCode: "CLIENT_CANCELLED",
    errorMessage: "Chat run was cancelled",
  });
  await waitForLockWait();
  const publication = repository.appendArtifactOutputToChatRun({
    ...scope(),
    artifactId: "artifact",
    artifactVersionId: "version",
    producer: { kind: "main" },
    sourceToolCallId: "publisher",
  });
  try {
    await waitForLockWait(2);
    await connection.query("commit");
    assert.equal((await cancelling)?.status, "cancelled");
    assert.equal(await publication, null);
    assert.equal((await current())?.status, "cancelled");
  } finally {
    await connection.query("rollback");
    connection.release();
    await Promise.all([cancelling, publication]);
  }
});

test("a committed publication queued before cancellation keeps the completed outcome", async () => {
  await repository.markChatThreadRunRunning(scope());
  const connection = await lockRun();
  const blockId = `artifact-output:${run.id}:artifact:version`;
  const publication = repository.updateChatThreadRunProgress({
    ...scope(),
    snapshotJson: {
      toolCalls: [
        {
          id: "publish-call",
          tool: "publish_video_presentation",
          input: {},
          output: {
            status: "ready",
            type: "committed_artifact_result",
            artifactType: "video_presentation",
            artifactId: "artifact",
            artifactVersionId: "version",
            artifactOutputBlockId: blockId,
            workflowVersion: "video-presentation-agent",
          },
          status: "completed",
          latencyMs: null,
          error: null,
          sequence: 1,
          producer: { kind: "main" },
        },
      ],
      renderBlocks: [
        {
          id: blockId,
          type: "artifact_output",
          artifactId: "artifact",
          artifactVersionId: "version",
          threadRunId: run.id,
          sourceToolCallId: "publish-call",
          placement: "terminal",
          producer: { kind: "main" },
          sequence: 1,
        },
      ],
    },
  });
  await waitForLockWait();
  const cancelling = repository.requestChatThreadRunCancel(scope());
  try {
    await waitForLockWait(2);
    await connection.query("commit");
    assert.ok(await publication);
    assert.equal((await cancelling)?.status, "completed");
    assert.equal((await current())?.status, "completed");
  } finally {
    await connection.query("rollback");
    connection.release();
    await Promise.all([publication, cancelling]);
  }
});

for (const status of ["failed", "completed"] as const) {
  test(`a worker observes persisted ${status} while a model is pending and cannot start its next tool`, async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let modelCalls = 0;
    let toolCalls = 0;
    let abortReason: unknown;
    vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
      async () => {},
    );
    mocked.stream.mockImplementation(async function* (_request, options) {
      modelCalls += 1;
      started();
      const signal = options.abortSignal as AbortSignal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortReason = signal.reason;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      toolCalls += 1;
      yield 'data: {"type":"finish"}\n\n';
    });
    const working = runner.processThreadChatRunJob({
      runId: run.id,
      teamId,
      workspaceId,
      threadId,
      userId: "test-user",
    });
    await modelStarted;
    await repository.finishChatThreadRun({
      ...scope(),
      status,
      ...(status === "failed"
        ? {
            errorCode: "CHAT_RUN_STALE",
            errorMessage: "worker ownership expired",
          }
        : {}),
    });
    const result = await working;
    assert.equal(result.status, status);
    if (status === "failed")
      assert.equal("errorCode" in result && result.errorCode, "CHAT_RUN_STALE");
    assert.equal(
      (abortReason as { code?: string })?.code,
      status === "failed" ? "CHAT_RUN_STALE" : "CHAT_RUN_OWNERSHIP_LOST",
    );
    assert.equal(modelCalls, 1);
    assert.equal(toolCalls, 0);
  });
}

test("worker completion commits before a failing Redis finish delivery and remains completed on attach", async () => {
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
  mocked.stream.mockImplementation(async function* () {
    yield 'data: {"type":"finish"}\n\n';
  });
  let terminalDeliveryAttempts = 0;
  vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockImplementation(
    async (_key, event) => {
      assert.equal((await current())?.status, "completed");
      assert.equal(JSON.parse(event.slice(6)).type, "finish");
      terminalDeliveryAttempts += 1;
      throw new Error("Redis terminal delivery failed");
    },
  );
  const result = await runner.processThreadChatRunJob({
    runId: run.id,
    teamId,
    workspaceId,
    threadId,
    userId: "test-user",
  });
  assert.equal(result.status, "completed");
  assert.equal(terminalDeliveryAttempts, 1);
  const attached = await service.testExports.resolveAttachRunState({
    run,
    offset: 0,
    sawErrorEvent: false,
    getEvents: async () => ({ events: [], nextOffset: 0 }),
  });
  assert.deepEqual(
    attached.terminalEvents!.map((event) => JSON.parse(event.slice(6))),
    [{ type: "finish" }],
  );
});

const jobPayload = () => ({
  runId: run.id,
  teamId,
  workspaceId,
  threadId,
  userId: "test-user",
});

for (const finishReason of ["stop", "tool_confirmation_requested"]) {
  test(`committed metering survives the real runner's final progress flush (${finishReason})`, async () => {
    const messages = await import("../message-repository");
    const { billingService } = await import("../../billing");
    const consume = vi
      .spyOn(billingService, "meterConsume")
      .mockRejectedValue(new Error("Progress must never charge again"));
    vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
      async () => {},
    );
    vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockImplementation(
      async (_key, event) => {
        emitted.push(event);
        return emitted.length;
      },
    );
    const call = {
      id: `settled:${run.id}`,
      consumedCredits: 23,
      billingStatus: "metered",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    };
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
      const prepared = {
        workspace: { id: workspaceId, organizationId: teamId },
        thread: { id: threadId },
        userMessage,
        userId: "test-user",
        runTraceId: run.id,
        modelAlias: "synthetic-chat",
        profileAlias: "synthetic-chat",
        preflightThinkingSteps: [],
      };
      const placeholder = await options.onPrepared(prepared);
      assistantId = placeholder.assistantMessageId;
      yield `data: ${JSON.stringify({ type: "text-delta", delta: "answer" })}\n\n`;
      const committed = await messages.updateMessageRecord({
        teamId,
        workspaceId,
        threadId,
        messageId: assistantId!,
        creditsConsumed: 23,
        metadata: {
          meteredLlmCalls: [call],
          meteredLlmCreditsConsumed: 23,
          usage: call.usage,
          finishReason,
          billingSkipped: false,
        },
      });
      await options.onFinalized({
        assistantMessage: committed,
        billing: {
          teamId,
          consumedCredits: 23,
          availableCredits: 77,
          consumedThisCycle: 23,
          idempotencyReplayed: false,
        },
      });
      // This progress event arrives after the finalizer committed, before the
      // assistant-message event forces the last flush in the production runner.
      yield `data: ${JSON.stringify({ type: "thinking-step", step: { id: "last-check", title: "Done", kind: "verification", status: "completed", items: [] } })}\n\n`;
      yield 'data: {"type":"text-end"}\n\n';
      yield `data: ${JSON.stringify({ type: "assistant-message", messageId: assistantId })}\n\n`;
      yield `data: ${JSON.stringify({ type: "finish", finishReason })}\n\n`;
    });
    const result = await runner.processThreadChatRunJob(jobPayload());
    assert.equal(
      result.status,
      finishReason === "stop" ? "completed" : "waiting_for_approval",
    );
    const stored = await messages.findMessageRecord({
      teamId,
      workspaceId,
      messageId: assistantId!,
    });
    assert.deepEqual(stored?.metadata.meteredLlmCalls, [call]);
    assert.equal(stored?.metadata.meteredLlmCreditsConsumed, 23);
    assert.equal(stored?.creditsConsumed, 23);
    assert.deepEqual(stored?.metadata.usage, call.usage);
    assert.equal(
      (stored?.metadata.thinkingSteps as Array<{ id: string }>).some(
        (s) => s.id === "last-check",
      ),
      true,
    );
    const saved = (await current())!.snapshotJson;
    assert.deepEqual(saved.meteredLlmCalls, [call]);
    assert.deepEqual(saved.usage, call.usage);
    assert.equal(consume.mock.calls.length, 0);
  });
}

async function useFailingPreparation(prepare: () => Promise<never>) {
  const { ContentThreadStreamService } =
    await vi.importActual<typeof import("../stream/service")>(
      "../stream/service",
    );
  const { billingService } = await import("../../billing");
  const streamService = new ContentThreadStreamService(
    { prepareThreadTurn: prepare } as never,
    undefined,
    undefined,
    undefined,
    billingService,
  );
  mocked.stream.mockImplementation(
    (...args: Parameters<typeof streamService.streamThreadEvents>) =>
      streamService.streamThreadEvents(...args),
  );
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
}

function captureCommittedFailureEvents(
  options: { failDelivery?: boolean } = {},
) {
  return vi
    .spyOn(streams.chatRunStreamManager, "appendEvent")
    .mockImplementation(async (_key, event) => {
      const stored = await current();
      assert.equal(
        stored?.status,
        "failed",
        "terminal SSE must follow the PostgreSQL commit",
      );
      emitted.push(event);
      if (options.failDelivery)
        throw new Error("Redis delivery is unavailable");
      return emitted.length;
    });
}

async function assertAttachedFailure(code: string, message: string) {
  const attached = await service.testExports.resolveAttachRunState({
    run,
    offset: 0,
    sawErrorEvent: false,
    getEvents: async () => ({ events: [], nextOffset: 0 }),
  });
  const events = attached.terminalEvents!.map((event) =>
    JSON.parse(event.slice(6)),
  );
  assert.equal(events[0].type, "error");
  assert.equal(events[0].code, code);
  assert.equal(events[0].error, message);
  assert.equal(events[1].type, "finish");
}

for (const failDelivery of [false, true]) {
  test(`prepare failure before messages commits its original error with no invented FK (delivery failure: ${failDelivery})`, async () => {
    const { ContentError } = await import("../../content/errors");
    const original = new ContentError(
      400,
      "PROFILE_NOT_FOUND",
      "Default image profile is missing",
    );
    await useFailingPreparation(async () => {
      throw original;
    });
    captureCommittedFailureEvents({ failDelivery });

    const result = await runner.processThreadChatRunJob(jobPayload());
    const stored = await current();
    assert.equal(result.status, "failed");
    assert.equal("errorCode" in result && result.errorCode, original.code);
    assert.equal(stored?.errorCode, original.code);
    assert.equal(stored?.errorMessage, original.message);
    assert.equal(stored?.userMessageId, null);
    assert.equal(stored?.assistantMessageId, null);
    assert.equal(
      (
        await schema.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.threadId, threadId))
      ).length,
      0,
    );
    assert.equal(emitted.length, failDelivery ? 1 : 2);
    assert.equal(JSON.parse(emitted[0]!.slice(6)).userMessageId, undefined);
    assert.equal(JSON.parse(emitted[0]!.slice(6)).messageId, undefined);
    await assertAttachedFailure(original.code, original.message);
  });
}

test("prepare failure after user insert links only the actual user row before onPrepared", async () => {
  const { ContentError } = await import("../../content/errors");
  const original = new ContentError(
    500,
    "PREPARE_FAILED",
    "Preparation failed after saving the user message",
  );
  const userMessageId = `run-user-${run.id}`;
  await useFailingPreparation(async () => {
    await schema.db.insert(schema.messages).values({
      id: userMessageId,
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "query",
      createdBy: run.userId,
    });
    throw original;
  });
  captureCommittedFailureEvents();
  const result = await runner.processThreadChatRunJob(jobPayload());
  const stored = await current();
  assert.equal(result.status, "failed");
  assert.equal(stored?.userMessageId, userMessageId);
  assert.equal(stored?.assistantMessageId, null);
  assert.equal(stored?.errorMessage, original.message);
  const messages = await schema.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, threadId));
  assert.deepEqual(
    messages.map((message) => message.id),
    [userMessageId],
  );
  assert.equal(JSON.parse(emitted[0]!.slice(6)).userMessageId, userMessageId);
});

test("terminal persistence failure reaches the processor with the original ContentError and no premature events", async () => {
  const { ContentError } = await import("../../content/errors");
  const original = new ContentError(
    400,
    "PROFILE_NOT_FOUND",
    "Default image profile is missing",
  );
  await useFailingPreparation(async () => {
    throw original;
  });
  const append = vi.spyOn(streams.chatRunStreamManager, "appendEvent");
  const finish = vi
    .spyOn(service.durableChatRunService, "finishRun")
    .mockRejectedValueOnce(new Error("SQL terminal write failed"));
  await assert.rejects(
    runner.processThreadChatRunJob(jobPayload()),
    (error) => error === original,
  );
  assert.equal((await current())?.status, "running");
  assert.equal(append.mock.calls.length, 0);
  finish.mockRestore();

  const { failThreadRunAtProcessorBoundary } =
    await import("../../../worker/processors/thread-chat-run");
  captureCommittedFailureEvents();
  const result = await failThreadRunAtProcessorBoundary({
    payload: jobPayload(),
    error: original,
  });
  assert.equal(result?.status, "failed");
  assert.equal((await current())?.errorCode, original.code);
  assert.equal((await current())?.errorMessage, original.message);
  assert.equal((await current())?.userMessageId, null);
  assert.deepEqual(
    emitted.map((event) => JSON.parse(event.slice(6)).type),
    ["error", "finish"],
  );
});

for (const winner of ["completed", "cancelled"] as const) {
  test(`processor failure loses terminal CAS to ${winner} without emitting speculative events`, async () => {
    const { ContentError } = await import("../../content/errors");
    const { failThreadRunAtProcessorBoundary } =
      await import("../../../worker/processors/thread-chat-run");
    await repository.markChatThreadRunRunning(scope());
    const append = vi.spyOn(streams.chatRunStreamManager, "appendEvent");
    const connection = await lockRun();
    const failing = failThreadRunAtProcessorBoundary({
      payload: jobPayload(),
      error: new ContentError(
        500,
        "PREPARE_FAILED",
        "late preparation failure",
      ),
    });
    try {
      await waitForLockWait();
      await connection.query(
        "update chat_thread_runs set status = $2, finished_at = now() where id = $1",
        [run.id, winner],
      );
      await connection.query("commit");
      assert.equal((await failing)?.status, winner);
      assert.equal((await current())?.status, winner);
      assert.equal((await current())?.errorMessage, null);
      assert.equal(append.mock.calls.length, 0);
    } finally {
      await connection.query("rollback");
      connection.release();
      await failing;
    }
  });
}

test("processor terminal delivery failure retains the original durable error for attach", async () => {
  const { ContentError } = await import("../../content/errors");
  const { failThreadRunAtProcessorBoundary } =
    await import("../../../worker/processors/thread-chat-run");
  const original = new ContentError(
    400,
    "PROFILE_NOT_FOUND",
    "Default image profile is missing",
  );
  captureCommittedFailureEvents({ failDelivery: true });
  const result = await failThreadRunAtProcessorBoundary({
    payload: jobPayload(),
    error: original,
  });
  assert.equal(result?.status, "failed");
  assert.equal((await current())?.errorMessage, original.message);
  assert.equal(emitted.length, 1);
  await assertAttachedFailure(original.code, original.message);
});

test("terminal failure preserves the current run's materialized message references over stale caller state", async () => {
  const { ContentError } = await import("../../content/errors");
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await schema.db.insert(schema.messages).values([
    {
      id: userMessageId,
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "query",
      createdBy: run.userId,
    },
    {
      id: assistantMessageId,
      teamId,
      workspaceId,
      threadId,
      role: "assistant",
      content: "partial answer",
    },
  ]);
  await repository.markChatThreadRunRunning(scope());
  await repository.updateChatThreadRunProgress({
    ...scope(),
    userMessageId,
    assistantMessageId,
  });
  captureCommittedFailureEvents();
  const original = new ContentError(
    500,
    "PREPARE_FAILED",
    "Original preparation error",
  );
  const result = await runner.persistTerminalFailure({
    run,
    status: "failed",
    assistantMessageId: "not-a-materialized-message",
    snapshot: {},
    contentError: original,
    finishRun: service.durableChatRunService.finishRun.bind(
      service.durableChatRunService,
    ),
    appendRunEvent: service.durableChatRunService.appendRunEvent.bind(
      service.durableChatRunService,
    ),
  });
  assert.equal(result.userMessageId, userMessageId);
  assert.equal(result.assistantMessageId, assistantMessageId);
  assert.equal((await current())?.userMessageId, userMessageId);
  assert.equal((await current())?.assistantMessageId, assistantMessageId);
  const [assistant] = await schema.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, assistantMessageId));
  assert.equal(assistant?.metadata?.errorCode, original.code);
  const event = JSON.parse(emitted[0]!.slice(6));
  assert.equal(event.userMessageId, userMessageId);
  assert.equal(event.messageId, assistantMessageId);
});

test("processor retains the original job error when its terminal write also fails", async () => {
  const { ContentError } = await import("../../content/errors");
  const { processThreadChatRunJob } =
    await import("../../../worker/processors/thread-chat-run");
  const original = new ContentError(
    400,
    "PROFILE_NOT_FOUND",
    "Default image profile is missing",
  );
  vi.spyOn(
    service.durableChatRunService,
    "processRunJob",
  ).mockRejectedValueOnce(original);
  vi.spyOn(service.durableChatRunService, "finishRun").mockRejectedValueOnce(
    new Error("PostgreSQL write unavailable"),
  );
  const append = vi.spyOn(streams.chatRunStreamManager, "appendEvent");
  await assert.rejects(
    processThreadChatRunJob({ data: jobPayload() } as never),
    (error) => error === original,
  );
  assert.equal((await current())?.status, "queued");
  assert.equal(append.mock.calls.length, 0);
});

test("a failed terminal-state read cannot replace the original preparation ContentError", async () => {
  const { ContentError } = await import("../../content/errors");
  const original = new ContentError(
    400,
    "PROFILE_NOT_FOUND",
    "Default image profile is missing",
  );
  const readRun = vi.spyOn(repository, "findChatThreadRunById");
  await useFailingPreparation(async () => {
    readRun.mockRejectedValueOnce(new Error("PostgreSQL read unavailable"));
    throw original;
  });
  const append = vi.spyOn(streams.chatRunStreamManager, "appendEvent");
  await assert.rejects(
    runner.processThreadChatRunJob(jobPayload()),
    (error) => error === original,
  );
  assert.equal((await current())?.status, "running");
  assert.equal(append.mock.calls.length, 0);
});

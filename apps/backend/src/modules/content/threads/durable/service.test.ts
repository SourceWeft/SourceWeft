import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatThreadRunRecord } from "./types";
import {
  isStaleActiveRun,
  normalizeRetrievalSnapshot,
  synthesizeTerminalRunEvents,
  testExports,
  toTerminalJobStatus,
  toTerminalRunError,
} from "./service";

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
}

function createRun(
  input: Partial<ChatThreadRunRecord> = {},
): ChatThreadRunRecord {
  const now = new Date(0).toISOString();
  return {
    id: "run-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "user-message-1",
    assistantMessageId: "assistant-message-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    jobId: "job-1",
    streamKey: "chat-run-events:run-1",
    status: "running",
    eventOffset: 0,
    requestJson: {},
    snapshotJson: {},
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

test("terminal run error preserves failed code and message", () => {
  const error = toTerminalRunError(
    createRun({
      status: "failed",
      errorCode: "CHAT_RUN_START_FAILED",
      errorMessage: "Queue unavailable",
    }),
  );

  assert.equal(error?.statusCode, 500);
  assert.equal(error?.code, "CHAT_RUN_START_FAILED");
  assert.equal(error?.message, "Queue unavailable");
});

test("terminal run error maps cancelled runs to 499", () => {
  const error = toTerminalRunError(
    createRun({
      status: "cancelled",
      errorCode: null,
      errorMessage: null,
    }),
  );

  assert.equal(error?.statusCode, 499);
  assert.equal(error?.code, "CLIENT_CANCELLED");
  assert.equal(error?.message, "Chat run was cancelled");
});

test("terminal job status preserves failed and cancelled terminal states", () => {
  assert.equal(toTerminalJobStatus("completed"), "completed");
  assert.equal(toTerminalJobStatus("failed"), "failed");
  assert.equal(toTerminalJobStatus("cancelled"), "cancelled");
  assert.equal(toTerminalJobStatus("waiting_for_approval"), "cancelled");
  assert.equal(toTerminalJobStatus("queued"), "cancelled");
  assert.equal(toTerminalJobStatus("cancel_requested"), "cancelled");
});

test("terminal attach fallback emits error and finish when Redis lacks terminal events", () => {
  const events = synthesizeTerminalRunEvents({
    run: createRun({
      status: "failed",
      errorCode: "CHAT_RUN_FAILED",
      errorMessage: "Model failed",
    }),
    sawErrorEvent: false,
  }).map(parseSseData);

  assert.deepEqual(events, [
    {
      type: "error",
      code: "CHAT_RUN_FAILED",
      error: "Model failed",
      userMessageId: "user-message-1",
      messageId: "assistant-message-1",
    },
    { type: "finish" },
  ]);
});

test("terminal attach fallback does not duplicate prior error event", () => {
  const events = synthesizeTerminalRunEvents({
    run: createRun({ status: "failed" }),
    sawErrorEvent: true,
  }).map(parseSseData);

  assert.deepEqual(events, [{ type: "finish" }]);
});

test("terminal attach fallback keeps stale run recovery silent", () => {
  const events = synthesizeTerminalRunEvents({
    run: createRun({
      status: "failed",
      errorCode: "CHAT_RUN_STALE",
      errorMessage: null,
    }),
    sawErrorEvent: false,
  }).map(parseSseData);

  assert.deepEqual(events, [{ type: "finish" }]);
});

test("snapshot metadata replaces render blocks with snapshot blocks", () => {
  const metadata = testExports.buildAssistantMessageSnapshotMetadata({
    currentMetadata: {
      renderBlocks: [
        { id: "reasoning-1", type: "reasoning", text: "Search pages." },
        { id: "tool-1", type: "tool", toolCallId: "search-page" },
        { id: "text-1", type: "text", text: "Found pages." },
      ],
      toolCalls: [],
    },
    run: createRun({ status: "completed" }),
    snapshot: {
      renderBlocks: [
        { id: "text-1", type: "text", text: "Rejected. Present summary." },
      ],
      toolCalls: [],
    },
  });

  assert.deepEqual(metadata.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Rejected. Present summary.",
    },
  ]);
});

test("stale active run recovery preserves terminal assistant metadata", async () => {
  const run = createRun({
    snapshotJson: {
      assistantMessage: {
        id: "assistant-message-1",
        metadata: {
          threadRun: {
            id: "run-1",
            status: "running",
          },
        },
      },
    },
  });
  let snapshotJson: Record<string, unknown> | undefined;
  let assistantMetadataRun: ChatThreadRunRecord | undefined;

  await testExports.failStaleActiveRunWithDependencies(run, {
    appendEvent: async () => 1,
    finishRun: async (input) => {
      snapshotJson = input.snapshotJson as Record<string, unknown>;
      return {
        ...run,
        status: "failed",
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      };
    },
    updateAssistantMetadata: async (input) => {
      assistantMetadataRun = input.run;
      return null;
    },
  });

  assert.equal(snapshotJson?.errorCode, "CHAT_RUN_STALE");
  assert.equal(
    (
      (snapshotJson?.assistantMessage as { metadata?: Record<string, unknown> })
        ?.metadata?.threadRun as { status?: string } | undefined
    )?.status,
    "failed",
  );
  assert.equal(assistantMetadataRun?.status, "failed");
});

test("forced stop terminalizes cancel_requested run and emits terminal events", async () => {
  const runningRun = createRun({
    status: "cancel_requested",
    userMessageId: "user-message-1",
    assistantMessageId: "assistant-message-1",
  });
  const appended: Array<{ streamKey: string; payload: string }> = [];
  let assistantMetadataUpdated = false;
  const finishInputs: Array<{
    runId: string;
    status: string;
    assistantMessageId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }> = [];
  const cancelledRun = createRun({
    status: "cancelled",
    errorCode: "CLIENT_CANCELLED",
    errorMessage: "Chat run was cancelled",
  });

  const result = await testExports.forceCancelStoppedRun(runningRun, {
    appendEvent: async (streamKey, payload) => {
      appended.push({ streamKey, payload });
      return appended.length;
    },
    finishRun: async (input) => {
      finishInputs.push(input);
      return cancelledRun;
    },
    findRunById: async () =>
      finishInputs.length === 0 ? runningRun : cancelledRun,
    updateAssistantMetadata: async () => {
      assistantMetadataUpdated = true;
      return null;
    },
  });

  assert.equal(result.status, "cancelled");
  assert.deepEqual(appended.map((event) => parseSseData(event.payload)), [
    {
      type: "error",
      code: "CLIENT_CANCELLED",
      error: "Chat run was cancelled",
      userMessageId: "user-message-1",
      messageId: "assistant-message-1",
    },
    { type: "finish" },
  ]);
  const finishInput = finishInputs[0];
  assert.ok(finishInput);
  assert.equal(finishInput?.runId, "run-1");
  assert.equal(finishInput?.status, "cancelled");
  assert.equal(finishInput?.assistantMessageId, "assistant-message-1");
  assert.equal(finishInput?.errorCode, "CLIENT_CANCELLED");
  assert.equal(finishInput?.errorMessage, "Chat run was cancelled");
  assert.equal(assistantMetadataUpdated, true);
});

test("forced stop preserves partial artifact snapshot metadata", async () => {
  const runningRun = createRun({
    status: "cancel_requested",
    snapshotJson: {
      assistantContent: "Partial answer",
      renderBlocks: [
        {
          id: "generated-presentation-pptx-tool",
          type: "generated_presentation",
          toolCallId: "pptx-tool",
        },
      ],
      toolCalls: [
        {
          id: "pptx-tool",
          tool: "generate_pptx",
          input: {},
          output: {
            type: "generate_pptx_progress",
            stage: "planning",
            toolCallId: "pptx-tool",
            title: "ASR",
          },
          status: "running",
          latencyMs: null,
          error: null,
        },
      ],
      thinkingSteps: [
        {
          id: "draft-presentation",
          title: "Generating presentation",
          status: "in_progress",
          items: [],
        },
      ],
      traceParts: [
        {
          id: "pptx-tool",
          kind: "tool",
          order: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          toolCallId: "pptx-tool",
          tool: "generate_pptx",
          status: "running",
          input: {},
          output: null,
          error: null,
          latencyMs: null,
        },
      ],
    },
  });
  let snapshotJson: Record<string, unknown> | undefined;
  let assistantMetadata: Record<string, unknown> | undefined;
  let assistantSnapshot: Record<string, unknown> | undefined;

  await testExports.forceCancelStoppedRun(runningRun, {
    appendEvent: async () => 1,
    finishRun: async (input) => {
      snapshotJson = input.snapshotJson as Record<string, unknown>;
      return {
        ...runningRun,
        status: "cancelled",
        snapshotJson: input.snapshotJson ?? {},
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      };
    },
    findRunById: async () =>
      createRun({
        ...runningRun,
        status: snapshotJson ? "cancelled" : "cancel_requested",
        snapshotJson: snapshotJson ?? runningRun.snapshotJson,
      }),
    updateAssistantMetadata: async (input: {
      metadata?: Record<string, unknown>;
      snapshot?: Record<string, unknown>;
    }) => {
      assistantMetadata = input.metadata;
      assistantSnapshot = input.snapshot;
      return null;
    },
  });

  assert.deepEqual(snapshotJson?.renderBlocks, [
    {
      id: "generated-presentation-pptx-tool",
      type: "generated_presentation",
      toolCallId: "pptx-tool",
    },
  ]);
  assert.deepEqual(snapshotJson?.toolCalls, [
    {
      id: "pptx-tool",
      tool: "generate_pptx",
      input: {},
      output: {
        type: "generate_pptx_progress",
        stage: "planning",
        toolCallId: "pptx-tool",
        title: "ASR",
      },
      status: "running",
      latencyMs: null,
      error: null,
    },
  ]);
  assert.equal(
    (snapshotJson?.thinkingSteps as Array<{ status?: string }> | undefined)?.[0]
      ?.status,
    "completed",
  );
  assert.equal(
    (snapshotJson?.traceParts as Array<{ status?: string }> | undefined)?.[0]
      ?.status,
    "error",
  );
  assert.deepEqual(assistantSnapshot?.renderBlocks, snapshotJson?.renderBlocks);
  assert.deepEqual(assistantSnapshot?.toolCalls, snapshotJson?.toolCalls);
  assert.equal(
    (assistantSnapshot?.thinkingSteps as Array<{ status?: string }> | undefined)
      ?.[0]?.status,
    "completed",
  );
  assert.deepEqual(assistantMetadata, {
    isCancelled: true,
    error: "Chat run was cancelled",
    errorCode: "CLIENT_CANCELLED",
  });
});

test("approval waiting runs with no pending confirmations can be completed", () => {
  assert.equal(
    testExports.shouldCompleteApprovalRunWithoutPendingConfirmations(
      createRun({
        status: "waiting_for_approval",
        snapshotJson: {
          toolCalls: [
            {
              id: "tool-1",
              output: {
                id: "confirmation-1",
                status: "approved",
                type: "tool_confirmation_request",
              },
            },
          ],
        },
      }),
    ),
    true,
  );
});

test("approval waiting runs with proposed confirmations remain active", () => {
  assert.equal(
    testExports.shouldCompleteApprovalRunWithoutPendingConfirmations(
      createRun({
        status: "waiting_for_approval",
        snapshotJson: {
          toolCalls: [
            {
              id: "tool-1",
              output: {
                id: "confirmation-1",
                status: "proposed",
                type: "tool_confirmation_request",
              },
            },
          ],
        },
      }),
    ),
    false,
  );
});

test("handled confirmation metadata replaces stale approval_requested tool calls", () => {
  const metadata = testExports.buildAssistantMessageConfirmationMetadata({
    currentMetadata: {
      finishReason: "tool_confirmation_requested",
      reasoning: "before approval",
      reasoningSegments: [
        {
          id: "reasoning-before",
          text: "Need approval before deleting.",
          sequence: 1,
        },
      ],
      thinkingSteps: [
        {
          id: "thinking-before",
          title: "Found matching page",
          status: "completed",
          items: ["Found 1 page."],
          sequence: 2,
        },
      ],
      toolCalls: [
        {
          id: "tool-1",
          output: {
            id: "confirmation-1",
            status: "proposed",
            type: "tool_confirmation_request",
          },
          status: "approval_requested",
        },
      ],
    },
    run: createRun({
      status: "completed",
    }),
    snapshot: {
      finishReason: "tool_confirmation_requested",
      reasoning: "before approval",
      reasoningSegments: [
        {
          id: "reasoning-before",
          text: "Need approval before deleting.",
          sequence: 1,
        },
      ],
      thinkingSteps: [
        {
          id: "thinking-before",
          title: "Found matching page",
          status: "completed",
          items: ["Found 1 page."],
          sequence: 2,
        },
      ],
      toolCalls: [
        {
          id: "tool-1",
          tool: "delete_notion_page",
          input: {},
          output: {
            id: "confirmation-1",
            status: "approved",
            type: "tool_confirmation_request",
          },
          status: "completed",
          latencyMs: 0,
          error: null,
          sequence: 3,
          approvalState: "approved",
          approvalConfirmationId: "confirmation-1",
        },
      ],
      traceParts: [
        {
          id: "reasoning-before",
          kind: "reasoning",
          order: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          text: "Need approval before deleting.",
        },
        {
          id: "tool-1",
          kind: "tool",
          order: 1,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          toolCallId: "tool-1",
          tool: "delete_notion_page",
          status: "completed",
          input: {},
          output: {
            id: "confirmation-1",
            status: "approved",
            type: "tool_confirmation_request",
          },
          latencyMs: 0,
          error: null,
          approvalState: "approved",
          approvalConfirmationId: "confirmation-1",
        },
      ],
    },
  });

  assert.deepEqual(metadata.toolCalls, [
    {
      id: "tool-1",
      tool: "delete_notion_page",
      input: {},
      output: {
        id: "confirmation-1",
        status: "approved",
        type: "tool_confirmation_request",
      },
      status: "completed",
      latencyMs: 0,
      error: null,
      sequence: 3,
      approvalState: "approved",
      approvalConfirmationId: "confirmation-1",
    },
  ]);
  assert.deepEqual(
    (metadata.traceParts as Array<Record<string, unknown>> | undefined)?.map(
      (part) =>
        part.kind === "tool"
          ? {
              id: part.id,
              kind: part.kind,
              order: part.order,
              status: part.status,
              approvalState: part.approvalState,
              approvalConfirmationId: part.approvalConfirmationId,
            }
          : {
              id: part.id,
              kind: part.kind,
              order: part.order,
            },
    ),
    [
      {
        id: "reasoning-before",
        kind: "reasoning",
        order: 0,
      },
      {
        id: "tool-1",
        kind: "tool",
        order: 1,
        status: "completed",
        approvalState: "approved",
        approvalConfirmationId: "confirmation-1",
      },
    ],
  );
  assert.equal(metadata.reasoning, "before approval");
  assert.deepEqual(metadata.reasoningSegments, [
    {
      id: "reasoning-before",
      text: "Need approval before deleting.",
      sequence: 1,
    },
  ]);
  assert.deepEqual(metadata.thinkingSteps, [
    {
      id: "thinking-before",
      title: "Found matching page",
      status: "completed",
      items: ["Found 1 page."],
      sequence: 2,
    },
  ]);
  assert.deepEqual(metadata.threadRun, {
    id: "run-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    status: "completed",
    streamKey: "chat-run-events:run-1",
  });
});

test("pending confirmation metadata keeps approval expiry on the assistant message", () => {
  const metadata = testExports.buildAssistantMessageConfirmationMetadata({
    currentMetadata: {
      reasoningSegments: [
        {
          id: "reasoning-before",
          text: "Need user approval.",
          sequence: 1,
        },
      ],
      threadRun: {
        approvalExpiresAt: "2026-05-24T01:00:00.000Z",
        approvalRequestedAt: "2026-05-24T00:00:00.000Z",
      },
    },
    run: createRun({
      status: "waiting_for_approval",
    }),
    snapshot: {
      reasoningSegments: [
        {
          id: "reasoning-before",
          text: "Need user approval.",
          sequence: 1,
        },
      ],
      toolCalls: [],
    },
  });

  assert.deepEqual(metadata.threadRun, {
    approvalExpiresAt: "2026-05-24T01:00:00.000Z",
    approvalRequestedAt: "2026-05-24T00:00:00.000Z",
    id: "run-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    mode: "send",
    status: "waiting_for_approval",
    streamKey: "chat-run-events:run-1",
  });
  assert.deepEqual(metadata.reasoningSegments, [
    {
      id: "reasoning-before",
      text: "Need user approval.",
      sequence: 1,
    },
  ]);
});

test("retrieval snapshot preserves string annIndexUsed", () => {
  assert.deepEqual(
    normalizeRetrievalSnapshot({
      embeddingProfileId: "embedding-profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "sources_embedding_hnsw_idx",
      citations: [{ citation: "c1" }],
    }),
    {
      embeddingProfileId: "embedding-profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "sources_embedding_hnsw_idx",
      citations: [{ citation: "c1" }],
      availableCitations: [{ citation: "c1" }],
    },
  );
});

test("stale active run uses heartbeat timestamp", () => {
  const now = Date.parse("2024-01-01T00:11:00.000Z");

  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "running",
        heartbeatAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:10:30.000Z",
      }),
      now,
    ),
    true,
  );
  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "running",
        heartbeatAt: "2024-01-01T00:09:30.000Z",
      }),
      now,
    ),
    false,
  );
});

test("queued run without job is stale after grace period", () => {
  const now = Date.parse("2024-01-01T00:00:11.000Z");

  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "queued",
        jobId: null,
        userMessageId: null,
        assistantMessageId: null,
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
      now,
    ),
    true,
  );
});

test("waiting approval runs are not heartbeat-stale", () => {
  const now = Date.parse("2024-01-01T01:00:00.000Z");

  assert.equal(
    isStaleActiveRun(
      createRun({
        status: "waiting_for_approval",
        heartbeatAt: "2024-01-01T00:00:00.000Z",
      }),
      now,
    ),
    false,
  );
});

test("finished active snapshots can be terminalized without waiting for heartbeat staleness", () => {
  assert.equal(
    testExports.resolveTerminalStatusFromFinishedSnapshot({
      assistantMessage: {
        id: "assistant-message-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content:
          "Command failed because generate_pptx did not create a slides artifact.",
        createdBy: null,
        model: null,
        creditsConsumed: null,
        contentJson: {},
        metadata: {
          finishReason: "command_success_criteria_failed",
        },
        createdAt: new Date(0).toISOString(),
      },
    }),
    "failed",
  );

  assert.equal(
    testExports.resolveTerminalStatusFromFinishedSnapshot({
      finishReason: "stop",
    }),
    "completed",
  );
  assert.equal(
    testExports.resolveTerminalStatusFromFinishedSnapshot({
      finishReason: "tool_confirmation_requested",
    }),
    null,
  );
});

test("terminal snapshots close active thinking steps and trace parts", () => {
  const snapshot = testExports.finalizeTerminalSnapshotTrace({
    thinkingSteps: [
      {
        id: "command-success",
        kind: "verification",
        title: "Checking command outcome",
        status: "in_progress",
        items: [],
        sequence: 1,
      },
    ],
    traceParts: [
      {
        id: "command-success",
        kind: "step",
        order: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        title: "Checking command outcome",
        status: "in_progress",
        items: [],
      },
    ],
  });

  assert.equal(
    (snapshot.thinkingSteps?.[0] as { status?: unknown } | undefined)?.status,
    "completed",
  );
  assert.equal(
    (snapshot.traceParts?.[0] as { status?: unknown } | undefined)?.status,
    "completed",
  );
});

test("finished active run is marked terminal from snapshot", async () => {
  const activeRun = createRun({
    status: "running",
    snapshotJson: {
      assistantMessage: {
        id: "assistant-message-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content:
          "Command failed because generate_pptx did not create a slides artifact.",
        createdBy: null,
        model: null,
        creditsConsumed: null,
        contentJson: {},
        metadata: {
          finishReason: "command_success_criteria_failed",
        },
        createdAt: new Date(0).toISOString(),
      },
    },
  });
  let finishInput:
    | {
        status: string;
        errorCode?: string | null;
        snapshotJson?: {
          assistantMessage?: {
            metadata?: {
              threadRun?: {
                status?: string;
              };
            };
          };
        };
      }
    | undefined;
  let updatedRunStatus: string | undefined;

  const result =
    await testExports.finishRunIfSnapshotIsTerminalWithDependencies(activeRun, {
      findRunById: async () => ({
        ...activeRun,
        status: "failed",
        errorCode: "CHAT_RUN_FAILED",
      }),
      finishRun: async (input) => {
        finishInput = input;
        return {
          ...activeRun,
          status: input.status,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
        };
      },
      updateAssistantMetadata: async (input) => {
        updatedRunStatus = input.run.status;
        return null;
      },
    });

  assert.equal(finishInput?.status, "failed");
  assert.equal(finishInput?.errorCode, "CHAT_RUN_FAILED");
  assert.equal(
    finishInput?.snapshotJson?.assistantMessage?.metadata?.threadRun?.status,
    "failed",
  );
  assert.equal(updatedRunStatus, "failed");
  assert.equal(result.status, "failed");
});

test("attach state fails stale running run and synthesizes terminal events", async () => {
  const staleRun = createRun({
    status: "running",
    heartbeatAt: "2024-01-01T00:00:00.000Z",
  });
  const failedRun = createRun({
    status: "failed",
    errorCode: "CHAT_RUN_STALE",
    errorMessage: null,
    finishedAt: "2024-01-01T00:11:00.000Z",
  });
  const failCalls: ChatThreadRunRecord[] = [];

  const result = await testExports.resolveAttachRunState({
    run: staleRun,
    offset: 0,
    sawErrorEvent: false,
    findRunById: async () => staleRun,
    failStaleRun: async (run) => {
      failCalls.push(run);
      return failedRun;
    },
    getEvents: async () => ({ events: [], nextOffset: 0 }),
  });

  assert.deepEqual(failCalls, [staleRun]);
  assert.equal(result.run.status, "failed");
  assert.deepEqual(result.terminalEvents?.map(parseSseData), [{ type: "finish" }]);
});

test("result wait turns stale active run terminal before timeout", async () => {
  const staleRun = createRun({
    status: "running",
    heartbeatAt: "2024-01-01T00:00:00.000Z",
  });
  const failedRun = createRun({
    status: "failed",
    errorCode: "CHAT_RUN_STALE",
    errorMessage: null,
    finishedAt: "2024-01-01T00:11:00.000Z",
  });
  let failCalls = 0;

  await assert.rejects(
    testExports.waitForRunResult({
      run: staleRun,
      timeoutMs: 1_000,
      requireTerminal: true,
      throwTerminalErrors: true,
      failStaleRun: async () => {
        failCalls += 1;
        return failedRun;
      },
      findRunById: async () => failedRun,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as { code?: string }).code, "CHAT_RUN_STALE");
      return true;
    },
  );

  assert.equal(failCalls, 1);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  chatThreadRuns,
  db,
  messages,
  threads,
  workspaces,
} from "@sourceweft/db";
import { updateMessageRecord } from "../message-repository";
import {
  appendArtifactOutputToChatRun,
  createChatThreadRun,
  finishChatThreadRun,
  findChatThreadRunById,
  markChatThreadRunRunning,
  markChatThreadRunQueued,
  markChatThreadRunWaitingForApproval,
  recordChatThreadRunConfirmationResponse,
  repairChatThreadRunArtifactOutputProjection,
  requestChatThreadRunCancel,
  updateChatThreadRunProgress,
} from "./repository";

let teamId: string;
let workspaceId: string;
let threadId: string;

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  threadId = randomUUID();

  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Durable repository test",
    slug: `durable-repository-test-${workspaceId}`,
  });

  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Durable repository test",
  });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

test("markChatThreadRunQueued records the job without reverting terminal status", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `sourceweft-web-run:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "hello",
    },
  });
  assert.ok(run);

  const running = await markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(running?.status, "running");

  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "completed",
    snapshotJson: { finishReason: "stop" },
  });
  assert.equal(finished?.status, "completed");

  const queued = await markChatThreadRunQueued({
    runId: run.id,
    teamId,
    workspaceId,
    jobId: "thread-chat-run_test",
  });

  assert.equal(queued?.status, "completed");
  assert.equal(queued?.jobId, "thread-chat-run_test");

  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(persisted?.status, "completed");
  assert.equal(persisted?.jobId, "thread-chat-run_test");
});

test("concurrent artifact outputs merge run and message blocks idempotently", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `artifact-output:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish two artifacts",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: {
      renderBlocks: [
        { id: "tool-publish", type: "tool", toolCallId: "publish" },
      ],
    },
  });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: { renderBlocks: [] },
  });

  const first = {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    producer: { kind: "main" as const },
    runId: run.id,
    sourceToolCallId: "publish",
    teamId,
    workspaceId,
  };
  await Promise.all([
    appendArtifactOutputToChatRun(first),
    appendArtifactOutputToChatRun({
      ...first,
      artifactId: "artifact-2",
      producer: {
        kind: "subagent" as const,
        subagentType: "general-purpose",
      },
      sourceToolCallId: "publish-child",
    }),
  ]);
  await appendArtifactOutputToChatRun(first);
  await assert.rejects(
    appendArtifactOutputToChatRun({
      ...first,
      sourceToolCallId: "different-publisher",
    }),
    /ARTIFACT_OUTPUT_ID_CONFLICT/,
  );

  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  const [message] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, assistantMessageId));
  const runBlocks = persisted?.snapshotJson.renderBlocks;
  const messageBlocks = message?.metadata.renderBlocks;
  assert.equal(Array.isArray(runBlocks) ? runBlocks.length : 0, 2);
  assert.equal(Array.isArray(messageBlocks) ? messageBlocks.length : 0, 3);
  const ids = (runBlocks as Array<{ id: string }>).map((block) => block.id);
  assert.deepEqual(
    new Set(ids),
    new Set([
      `artifact-output:${run.id}:artifact-1:version-1`,
      `artifact-output:${run.id}:artifact-2:version-1`,
    ]),
  );
});

test("stale progress cannot erase a committed artifact output or regress its cursor", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `stale-progress:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish while streaming",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    eventOffset: 10,
    snapshotJson: {
      renderBlocks: [{ id: "tool-old", type: "tool", toolCallId: "old" }],
    },
  });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-progress",
    artifactVersionId: "version-progress",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-progress",
    teamId,
    workspaceId,
  });
  assert.ok(block);

  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    eventOffset: 4,
    snapshotJson: {
      assistantContent: "new text",
      renderBlocks: [{ id: "tool-new", type: "tool", toolCallId: "new" }],
    },
  });

  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  const [message] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, assistantMessageId));
  assert.equal(persisted?.eventOffset, 10);
  assert.equal(persisted?.snapshotJson.assistantContent, "new text");
  assert.deepEqual(persisted?.snapshotJson.renderBlocks, [
    { id: "tool-new", type: "tool", toolCallId: "new" },
    block,
  ]);
  assert.deepEqual(message?.metadata.renderBlocks, [block]);
});

test("stale assistant metadata cannot erase a committed artifact output", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `stale-message:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish while message metadata flushes",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: { renderBlocks: [] },
  });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-message",
    artifactVersionId: "version-message",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-message",
    teamId,
    workspaceId,
  });
  assert.ok(block);

  const updated = await updateMessageRecord({
    teamId,
    workspaceId,
    threadId,
    messageId: assistantMessageId,
    metadata: {
      renderBlocks: [{ id: "tool-stale", type: "tool", toolCallId: "stale" }],
    },
  });

  assert.deepEqual(updated?.metadata.renderBlocks, [
    { id: "tool-stale", type: "tool", toolCallId: "stale" },
    block,
  ]);
});

test("stale finish preserves committed blocks and missing snapshots preserve state", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `stale-finish:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish then finish",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-finish",
    artifactVersionId: "version-finish",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-finish",
    teamId,
    workspaceId,
  });
  assert.ok(block);

  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "completed",
  });

  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.snapshotJson.renderBlocks, [block]);
});

test("approval snapshot transitions preserve committed artifact outputs", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `approval-snapshot:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "wait for approval",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: { renderBlocks: [] },
  });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-approval",
    artifactVersionId: "version-approval",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-approval",
    teamId,
    workspaceId,
  });
  assert.ok(block);

  const waiting = await markChatThreadRunWaitingForApproval({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: {
      finishReason: "tool_confirmation_requested",
      pendingConfirmationIds: ["confirmation-1"],
      toolCalls: [
        {
          id: "approval-call-1",
          tool: "approval_tool",
          input: {},
          output: {
            type: "tool_confirmation_request",
            id: "confirmation-1",
            status: "proposed",
          },
          status: "approval_requested",
          latencyMs: null,
          error: null,
          sequence: 1,
        },
      ],
    },
  });
  assert.deepEqual(waiting?.snapshotJson.renderBlocks, [block]);
  const approvalUpdated = await recordChatThreadRunConfirmationResponse({
    runId: run.id,
    teamId,
    workspaceId,
    confirmationId: "confirmation-1",
    confirmation: {
      type: "tool_confirmation_request",
      id: "confirmation-1",
      status: "approved",
    },
  });
  assert.deepEqual(approvalUpdated?.snapshotJson.renderBlocks, [block]);
  assert.equal(approvalUpdated?.status, "completed");
});

test("concurrent confirmation responses merge against the locked snapshot", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `concurrent-approval:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "approve both actions",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  const toolCalls = ["a", "b"].map((suffix, index) => ({
    id: `approval-call-${suffix}`,
    tool: "approval_tool",
    input: {},
    output: {
      type: "tool_confirmation_request",
      id: `confirmation-${suffix}`,
      status: "proposed",
    },
    status: "approval_requested",
    latencyMs: null,
    error: null,
    sequence: index + 1,
  }));
  await markChatThreadRunWaitingForApproval({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: {
      finishReason: "tool_confirmation_requested",
      pendingConfirmationIds: ["confirmation-a", "confirmation-b"],
      toolCalls,
    },
  });

  await Promise.all(
    ["a", "b"].map((suffix) =>
      recordChatThreadRunConfirmationResponse({
        runId: run.id,
        teamId,
        workspaceId,
        confirmationId: `confirmation-${suffix}`,
        confirmation: {
          type: "tool_confirmation_request",
          id: `confirmation-${suffix}`,
          status: "approved",
        },
      }),
    ),
  );

  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(persisted?.status, "completed");
  assert.deepEqual(persisted?.snapshotJson.pendingConfirmationIds, []);
  const persistedToolCalls = persisted?.snapshotJson.toolCalls as Array<{
    status?: string;
    approvalState?: string;
  }>;
  assert.equal(persistedToolCalls.length, 2);
  assert.ok(
    persistedToolCalls.every(
      (toolCall) =>
        toolCall.status === "completed" &&
        toolCall.approvalState === "approved",
    ),
  );
});

test("cancel fence rejects progress but cancelled finish preserves committed outputs", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `cancel-snapshot:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "cancel after publish",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-cancel",
    artifactVersionId: "version-cancel",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-cancel",
    teamId,
    workspaceId,
  });
  assert.ok(block);
  const cancelRequested = await requestChatThreadRunCancel({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(cancelRequested?.status, "cancel_requested");
  const progress = await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    snapshotJson: { renderBlocks: [] },
  });
  assert.equal(progress, null);

  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "cancelled",
    snapshotJson: {
      errorCode: "CLIENT_CANCELLED",
      renderBlocks: [],
    },
  });
  assert.equal(finished?.status, "cancelled");
  assert.deepEqual(finished?.snapshotJson.renderBlocks, [block]);
});

test("stop arriving after atomic publication preserves the committed completion", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `post-publication-stop:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish then stop",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  const blockId = `artifact-output:${run.id}:artifact-1:version-1`;
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
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
            artifactId: "artifact-1",
            artifactVersionId: "version-1",
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
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          threadRunId: run.id,
          sourceToolCallId: "publish-call",
          placement: "terminal",
          producer: { kind: "main" },
          sequence: 1,
        },
      ],
    },
  });

  const stopped = await requestChatThreadRunCancel({
    runId: run.id,
    teamId,
    workspaceId,
  });

  assert.equal(stopped?.status, "completed");
  assert.equal(stopped?.finishedAt === null, false);
});

test("stale recovery terminal patch preserves newer runner-owned state", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `terminal-patch:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "preserve newer progress",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    snapshotJson: {
      assistantContent: "newer runner text",
      toolCalls: [
        {
          id: "new-tool",
          tool: "new_tool",
          input: {},
          output: { ok: true },
          status: "completed",
          latencyMs: 1,
          error: null,
          sequence: 1,
        },
      ],
    },
  });

  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "failed",
    snapshotMode: "terminal_patch",
    snapshotJson: {
      assistantContent: "stale text",
      toolCalls: [],
      errorCode: "CHAT_RUN_STALE",
      errorMessage: "Run became stale",
    },
    errorCode: "CHAT_RUN_STALE",
    errorMessage: "Run became stale",
  });

  assert.equal(finished?.status, "failed");
  assert.equal(finished?.snapshotJson.assistantContent, "newer runner text");
  assert.equal(finished?.snapshotJson.errorCode, "CHAT_RUN_STALE");
  assert.equal(
    Array.isArray(finished?.snapshotJson.toolCalls)
      ? finished.snapshotJson.toolCalls.length
      : 0,
    1,
  );
});

test("terminal runs reject stale progress writes", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `terminal-progress:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "finish",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "completed",
    snapshotJson: { finishReason: "stop" },
  });

  const updated = await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    eventOffset: 99,
    snapshotJson: { finishReason: "stale", renderBlocks: [] },
  });
  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });

  assert.equal(updated, null);
  assert.equal(persisted?.eventOffset, 0);
  assert.deepEqual(persisted?.snapshotJson, { finishReason: "stop" });
});

test("a later assistant message repairs committed blocks from the run snapshot", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `message-repair:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "publish before placeholder",
    },
  });
  assert.ok(run);
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-repair",
    artifactVersionId: "version-repair",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-repair",
    teamId,
    workspaceId,
  });
  assert.ok(block);

  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: { renderBlocks: [] },
  });

  const [message] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, assistantMessageId));
  assert.deepEqual(message?.metadata.renderBlocks, [block]);
});

test("terminal read repair restores only committed artifact projection", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `terminal-repair:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "repair a legacy projection",
    },
  });
  assert.ok(run);
  const assistantMessageId = randomUUID();
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: { renderBlocks: [] },
  });
  await markChatThreadRunRunning({ runId: run.id, teamId, workspaceId });
  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    assistantMessageId,
    snapshotJson: { renderBlocks: [] },
  });
  const block = await appendArtifactOutputToChatRun({
    artifactId: "artifact-terminal-repair",
    artifactVersionId: "version-terminal-repair",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "publish-terminal-repair",
    teamId,
    workspaceId,
  });
  assert.ok(block);
  await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "completed",
    assistantMessageId,
    snapshotJson: { finishReason: "stop" },
  });
  // Characterize a legacy/full-writer divergence without exposing a production
  // API that can overwrite terminal snapshots.
  await db
    .update(chatThreadRuns)
    .set({ snapshotJson: { finishReason: "stop" } })
    .where(eq(chatThreadRuns.id, run.id));

  const repaired = await repairChatThreadRunArtifactOutputProjection({
    runId: run.id,
    teamId,
    workspaceId,
  });

  assert.equal(repaired?.status, "completed");
  assert.equal(repaired?.snapshotJson.finishReason, "stop");
  assert.deepEqual(repaired?.snapshotJson.renderBlocks, [block]);
});

test("cancelled runs reject late artifact outputs", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `cancelled-artifact-output:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "cancel this generation",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "cancelled",
    snapshotJson: { finishReason: "cancelled" },
  });

  const result = await appendArtifactOutputToChatRun({
    artifactId: "artifact-late",
    artifactVersionId: "version-late",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "generate-late",
    teamId,
    workspaceId,
  });

  assert.equal(result, null);
  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.deepEqual(persisted?.snapshotJson, { finishReason: "cancelled" });
});

test("completed runs reject late background artifact outputs", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `completed-artifact-output:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "finish before the artifact",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  await finishChatThreadRun({
    runId: run.id,
    teamId,
    workspaceId,
    status: "completed",
    snapshotJson: { finishReason: "stop" },
  });

  const result = await appendArtifactOutputToChatRun({
    artifactId: "artifact-late",
    artifactVersionId: "version-late",
    producer: { kind: "main" },
    runId: run.id,
    sourceToolCallId: "generate-late",
    teamId,
    workspaceId,
  });

  assert.equal(result, null);
});

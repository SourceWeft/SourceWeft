import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { db, messages, threads, workspaces } from "@sourceweft/db";
import {
  appendArtifactOutputToChatRun,
  createChatThreadRun,
  finishChatThreadRun,
  findChatThreadRunById,
  markChatThreadRunRunning,
  markChatThreadRunQueued,
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
  assert.deepEqual(runBlocks, messageBlocks);
  assert.equal(Array.isArray(runBlocks) ? runBlocks.length : 0, 3);
  const ids = (runBlocks as Array<{ id: string }>).map((block) => block.id);
  assert.equal(ids[0], "tool-publish");
  assert.deepEqual(
    new Set(ids.slice(1)),
    new Set([
      `artifact-output:${run.id}:artifact-1:version-1`,
      `artifact-output:${run.id}:artifact-2:version-1`,
    ]),
  );
});

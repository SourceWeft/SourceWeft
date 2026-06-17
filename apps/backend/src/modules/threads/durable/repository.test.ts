import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { db, threads, workspaces } from "@sourceweft/db";
import {
  createChatThreadRun,
  finishChatThreadRun,
  findChatThreadRunById,
  markChatThreadRunRunning,
  markChatThreadRunQueued,
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
    requestJson: {},
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

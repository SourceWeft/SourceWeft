import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  artifactVersions,
  artifacts,
  db,
  threads,
  workspaces,
} from "@sourceweft/db";
import {
  createChatThreadRun,
  finishChatThreadRun,
  markChatThreadRunRunning,
} from "../threads/durable/repository";
import { createPendingArtifactRecord, markArtifactReady } from "./repository";

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
    name: "Artifact run fence test",
    slug: `artifact-run-fence-${workspaceId}`,
  });
  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Artifact run fence test",
  });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

test("a cancelled durable run atomically fences artifact publication", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `artifact-run-fence:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "generate a video",
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

  const artifactId = randomUUID();
  await createPendingArtifactRecord({
    artifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    title: "Cancelled video",
    prompt: "Generate a cancelled video",
    payload: { generation: { status: "pending" } },
  });

  const result = await markArtifactReady({
    artifactId,
    teamId,
    workspaceId,
    userId: "user-1",
    payload: { generation: { status: "ready" } },
    expectedStatuses: ["pending", "running"],
    publishRunFence: { runId: run.id, teamId, workspaceId },
  });

  assert.equal(result, null);
  const [artifact] = await db
    .select({ status: artifacts.status, payload: artifacts.payloadJson })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  const versions = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId));
  assert.equal(artifact?.status, "pending");
  assert.deepEqual(artifact?.payload, { generation: { status: "pending" } });
  assert.equal(versions.length, 0);
});

test("an active durable run may publish through the same fence", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `active-artifact-run-fence:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "generate a video",
    },
  });
  assert.ok(run);
  await markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  const artifactId = randomUUID();
  await createPendingArtifactRecord({
    artifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    title: "Active video",
    prompt: "Generate an active video",
    payload: { generation: { status: "pending" } },
  });

  const result = await markArtifactReady({
    artifactId,
    teamId,
    workspaceId,
    userId: "user-1",
    payload: { generation: { status: "ready" } },
    expectedStatuses: ["pending", "running"],
    publishRunFence: { runId: run.id, teamId, workspaceId },
  });

  assert.equal(result?.artifactId, artifactId);
  assert.equal(result?.versionNo, 1);
});

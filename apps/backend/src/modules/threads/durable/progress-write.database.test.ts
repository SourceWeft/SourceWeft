import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ChatThreadRunStatus } from "./types";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
const originalUrl = process.env.DATABASE_URL;
const teamId = randomUUID(),
  workspaceId = randomUUID(),
  threadId = randomUUID();
let runId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("run_progress");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Progress writes",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, teamId, workspaceId, title: "Progress writes" });
}, 120_000);

beforeEach(async () => {
  const created = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "test-user",
    mode: "send",
    idempotencyKey: randomUUID(),
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "test-user",
      content: "request-only-" + "x".repeat(2 * 1024 * 1024),
    },
  });
  assert.ok(created);
  runId = created.id;
  await repository.markChatThreadRunRunning(scope());
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ snapshotJson: { reasoning: "y".repeat(5 * 1024 * 1024) } })
    .where(eq(schema.chatThreadRuns.id, runId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});
const scope = () => ({ runId, teamId, workspaceId });
const current = () => repository.findChatThreadRunById(scope());

test("heartbeat returns only control timestamps with large payloads and preserves terminal/scope guards", async () => {
  for (const status of [
    "queued",
    "running",
    "cancel_requested",
    "waiting_for_approval",
  ] as ChatThreadRunStatus[]) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({ status, errorCode: "CUSTOM", errorMessage: "detail" })
      .where(eq(schema.chatThreadRuns.id, runId));
    const receipt = await repository.touchChatThreadRunHeartbeat(scope());
    assert.equal(receipt?.status, status);
    assert.equal(receipt?.errorCode, "CUSTOM");
    assert.equal(receipt?.errorMessage, "detail");
    assert.deepEqual(Object.keys(receipt!).sort(), [
      "errorCode",
      "errorMessage",
      "heartbeatAt",
      "status",
      "updatedAt",
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 400);
  }
  for (const denied of [
    { ...scope(), runId: randomUUID() },
    { ...scope(), teamId: randomUUID() },
    { ...scope(), workspaceId: randomUUID() },
  ]) {
    assert.equal(await repository.touchChatThreadRunHeartbeat(denied), null);
  }
  for (const status of [
    "completed",
    "failed",
    "cancelled",
  ] as ChatThreadRunStatus[]) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({ status })
      .where(eq(schema.chatThreadRuns.id, runId));
    assert.equal(await repository.touchChatThreadRunHeartbeat(scope()), null);
    assert.equal((await current())?.status, status);
  }
});

test("write-only progress persists the same full snapshot and monotonic offset without returning payloads", async () => {
  assert.equal(
    await repository.updateChatThreadRunProgress({
      ...scope(),
      eventOffset: 8,
      snapshotJson: { reasoning: "new reasoning", lastEventType: "reasoning" },
      returnRecord: false,
    }),
    undefined,
  );
  const updated = await current();
  assert.equal(updated?.eventOffset, 8);
  assert.equal(updated?.snapshotJson.reasoning, "new reasoning");
  assert.ok(JSON.stringify(updated?.requestJson).length > 2 * 1024 * 1024);
  const full = await repository.updateChatThreadRunProgress({
    ...scope(),
    eventOffset: 3,
  });
  assert.equal(full?.eventOffset, 8);
  assert.deepEqual(full?.snapshotJson, updated?.snapshotJson);
  for (const denied of [
    { ...scope(), teamId: randomUUID() },
    { ...scope(), workspaceId: randomUUID() },
  ]) {
    await repository.updateChatThreadRunProgress({
      ...denied,
      eventOffset: 90,
      snapshotJson: { reasoning: "denied" },
      returnRecord: false,
    });
  }
  for (const status of [
    "cancel_requested",
    "waiting_for_approval",
    "completed",
    "failed",
    "cancelled",
  ] as ChatThreadRunStatus[]) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({ status })
      .where(eq(schema.chatThreadRuns.id, runId));
    await repository.updateChatThreadRunProgress({
      ...scope(),
      eventOffset: 90,
      snapshotJson: { reasoning: "stale" },
      returnRecord: false,
    });
    const guarded = await current();
    assert.equal(guarded?.status, status);
    assert.equal(guarded?.eventOffset, 8);
    assert.equal(guarded?.snapshotJson.reasoning, "new reasoning");
  }
});

test("streaming progress skips unchanged publication metadata but preserves additions and rejects identity conflicts", async () => {
  const messageId = randomUUID();
  await schema.db.insert(schema.messages).values({
    id: messageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: {
      renderBlocks: [],
      sentinel: "metadata-only-" + "z".repeat(1024 * 1024),
    },
  });
  await repository.updateChatThreadRunProgress({
    ...scope(),
    assistantMessageId: messageId,
  });
  const block = {
    id: `artifact-output:${runId}:artifact:version`,
    type: "artifact_output",
    artifactId: "artifact",
    artifactVersionId: "version",
    threadRunId: runId,
    sourceToolCallId: "publish",
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
  };
  await repository.updateChatThreadRunProgress({
    ...scope(),
    snapshotJson: { renderBlocks: [block] },
    returnRecord: false,
  });
  const version = async () =>
    (
      await schema.database.query(
        "select xmin::text as revision, metadata->'renderBlocks' as blocks from messages where id=$1",
        [messageId],
      )
    ).rows[0];
  const first = await version();
  assert.deepEqual(first.blocks, [block]);
  await repository.updateChatThreadRunProgress({
    ...scope(),
    eventOffset: 2,
    snapshotJson: { reasoning: "streamed", renderBlocks: [] },
    returnRecord: false,
  });
  assert.deepEqual(await version(), first);
  assert.equal((await current())?.snapshotJson.reasoning, "streamed");
  const second = {
    ...block,
    id: `artifact-output:${runId}:artifact-2:version-2`,
    artifactId: "artifact-2",
    artifactVersionId: "version-2",
    sourceToolCallId: "publish-2",
  };
  await repository.updateChatThreadRunProgress({
    ...scope(),
    snapshotJson: { renderBlocks: [block, second] },
    returnRecord: false,
  });
  const added = await version();
  assert.notEqual(added.revision, first.revision);
  assert.deepEqual(added.blocks, [block, second]);
  // A stale/untrusted incoming block is repaired from committed authority.
  await repository.updateChatThreadRunProgress({
    ...scope(),
    snapshotJson: { renderBlocks: [{ ...block, artifactVersionId: "forged" }] },
    returnRecord: false,
  });
  assert.deepEqual(await version(), added);
  // Conflicting persisted authorities still fail; the equality shortcut must
  // not bypass the existing identity validation.
  await schema.db
    .update(schema.messages)
    .set({
      metadata: {
        renderBlocks: [{ ...block, artifactVersionId: "forged" }, second],
      },
    })
    .where(eq(schema.messages.id, messageId));
  await assert.rejects(
    repository.updateChatThreadRunProgress({
      ...scope(),
      snapshotJson: { reasoning: "must roll back" },
      returnRecord: false,
    }),
    /ARTIFACT_OUTPUT_AUTHORITY_CONFLICT/,
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
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
  isolated = await createIsolatedTestDatabase("run_attach_state");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Attach state projection",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, teamId, workspaceId, title: "Attach state" });
  const run = await repository.createChatThreadRun({
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
  assert.ok(run);
  runId = run.id;
  await schema.db
    .update(schema.chatThreadRuns)
    .set({
      snapshotJson: {
        snapshotSentinel: "snapshot-only-" + "y".repeat(5 * 1024 * 1024),
      },
    })
    .where(eq(schema.chatThreadRuns.id, runId));
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

const scope = () => ({ runId, teamId, workspaceId });

test("large durable payloads never leave the scoped attach-control projection", async () => {
  const at = new Date("2026-10-16T00:00:00.000Z");
  const statuses: ChatThreadRunStatus[] = [
    "queued",
    "running",
    "cancel_requested",
    "waiting_for_approval",
    "completed",
    "failed",
    "cancelled",
  ];
  for (const status of statuses) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({
        status,
        jobId: "job-1",
        eventOffset: 123,
        streamKey: "attach-stream",
        errorCode: "PERSISTED_CODE",
        errorMessage: "Persisted message",
        startedAt: at,
        heartbeatAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .where(eq(schema.chatThreadRuns.id, runId));
    const state = await repository.findChatThreadRunAttachState(scope());
    assert.deepEqual(state, {
      status,
      jobId: "job-1",
      streamKey: "attach-stream",
      eventOffset: 123,
      errorCode: "PERSISTED_CODE",
      errorMessage: "Persisted message",
      startedAt: at.toISOString(),
      heartbeatAt: at.toISOString(),
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    });
    assert.deepEqual(
      Object.keys(state!).sort(),
      [
        "status",
        "jobId",
        "streamKey",
        "eventOffset",
        "errorCode",
        "errorMessage",
        "startedAt",
        "heartbeatAt",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    assert.doesNotMatch(JSON.stringify(state), /snapshot-only-|request-only-/);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 1000);
  }
  const full = await repository.findChatThreadRunById(scope());
  assert.ok(full && JSON.stringify(full.snapshotJson).length > 5 * 1024 * 1024);
  assert.ok(full && JSON.stringify(full.requestJson).length > 2 * 1024 * 1024);
}, 30_000);

test("attach projection preserves nullable worker timestamps and queued job", async () => {
  await schema.db
    .update(schema.chatThreadRuns)
    .set({ status: "queued", jobId: null, startedAt: null, heartbeatAt: null })
    .where(eq(schema.chatThreadRuns.id, runId));
  const state = await repository.findChatThreadRunAttachState(scope());
  assert.ok(state);
  assert.equal(state.jobId, null);
  assert.equal(state.startedAt, null);
  assert.equal(state.heartbeatAt, null);
});

test("attach projection rejects missing ids and mismatched team/workspace scopes", async () => {
  for (const denied of [
    { ...scope(), runId: randomUUID() },
    { ...scope(), teamId: randomUUID() },
    { ...scope(), workspaceId: randomUUID() },
  ]) {
    assert.equal(await repository.findChatThreadRunAttachState(denied), null);
  }
});

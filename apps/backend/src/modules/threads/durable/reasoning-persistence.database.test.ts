import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, threads, workspaces } from "@sourceweft/db";
import { MAX_SNAPSHOT_REASONING_CHARS } from "./reasoning-bounds";
import {
  createChatThreadRun,
  findChatThreadRunById,
  markChatThreadRunRunning,
  updateChatThreadRunProgress,
} from "./repository";
import { testExports } from "./runner";
import type { ChatRunSnapshot } from "./types";

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
    name: "Reasoning persistence test",
    slug: `reasoning-persistence-test-${workspaceId}`,
  });

  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Reasoning persistence test",
  });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

test("a 10k-delta Thinking run persists a bounded snapshot row", async () => {
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `reasoning-persistence:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "think hard",
    },
  });
  assert.ok(run);
  const running = await markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(running?.status, "running");

  // Synthetic run: 10,000 reasoning deltas over four model calls separated by
  // tool results, flushed the way the durable runner flushes (every raw SSE
  // event updates the snapshot, periodic full-snapshot writes). Deltas are
  // token-sized: the measured baseline run streamed ~3.7 chars per delta.
  const segments = 4;
  const deltasPerSegment = 2_500;
  const delta = "token "; // 6 chars → 15,000 chars per segment, 60,000 total
  let snapshot: ChatRunSnapshot = {
    reasoningRun: { runId: run.id, parentRunId: null, base: "" },
    assistantContent: "",
  };
  let streamedChars = 0;
  for (let segment = 0; segment < segments; segment++) {
    const segmentId = `model-reasoning-${segment + 1}`;
    for (let index = 0; index < deltasPerSegment; index++) {
      snapshot = testExports.updateSnapshotFromPayload(snapshot, {
        type: "reasoning",
        reasoning: delta,
        segment: {
          id: segmentId,
          sequence: segment * 2 + 1,
          phase: segment === 0 ? "initial" : "after_tool",
        },
      });
      streamedChars += delta.length;
    }
    if (segment % 2 === 1) {
      // Flush mid-run through the repository, as the runner does.
      await updateChatThreadRunProgress({
        runId: run.id,
        teamId,
        workspaceId,
        eventOffset: (segment + 1) * deltasPerSegment,
        snapshotJson: snapshot,
        returnRecord: false,
      });
    }
    snapshot = testExports.updateSnapshotFromPayload(snapshot, {
      type: "tool-call-result",
      id: `tool-${segment + 1}`,
      tool: "search_notion_pages",
      toolCall: {
        id: `tool-${segment + 1}`,
        tool: "search_notion_pages",
        input: {},
        output: null,
        status: "completed",
        sequence: segment * 2 + 2,
      },
    });
  }
  assert.equal(streamedChars, segments * deltasPerSegment * delta.length);
  assert.ok(streamedChars <= MAX_SNAPSHOT_REASONING_CHARS);

  await updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    eventOffset: segments * (deltasPerSegment + 1),
    snapshotJson: snapshot,
    returnRecord: false,
  });

  const [row] = (
    await db.execute(sql`
      select
        octet_length(snapshot_json::text) as snapshot_bytes,
        jsonb_array_length(snapshot_json->'traceEvents') as trace_events,
        length(snapshot_json->>'reasoning') as reasoning_chars
      from chat_thread_runs
      where id = ${run.id}
    `)
  ).rows as Array<{
    snapshot_bytes: number | string;
    trace_events: number | string;
    reasoning_chars: number | string;
  }>;
  assert.ok(row);
  const snapshotBytes = Number(row.snapshot_bytes);
  assert.ok(
    snapshotBytes < 300_000,
    `snapshot_json is ${snapshotBytes} bytes after ${segments * deltasPerSegment} reasoning deltas`,
  );
  assert.equal(Number(row.trace_events), segments * 2);
  assert.equal(Number(row.reasoning_chars), streamedChars);

  const persisted = await findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  const persistedSnapshot = persisted?.snapshotJson as ChatRunSnapshot;
  assert.equal(
    persistedSnapshot.reasoning,
    delta.repeat(deltasPerSegment * segments),
  );
  assert.equal(
    persistedSnapshot.reasoningRevision,
    segments * deltasPerSegment,
  );
  assert.equal(
    (persistedSnapshot.renderBlocks ?? []).filter(
      (block) => (block as { type?: string }).type === "reasoning",
    ).length,
    segments,
  );
});

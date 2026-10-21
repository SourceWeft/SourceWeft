import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { sql } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ChatRunSnapshot } from "./types";

// The runner module chain binds the DB singleton at import time, so every
// module that reaches @sourceweft/db is imported only after DATABASE_URL points
// at this test's own clone of the migrated template; the shared lane database
// is never touched.
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let runner: typeof import("./runner");
let snapshotModule: typeof import("./snapshot");
const originalUrl = process.env.DATABASE_URL;
const teamId = randomUUID();
const workspaceId = randomUUID();
const threadId = randomUUID();

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("tool_trace");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  runner = await import("./runner");
  snapshotModule = await import("./snapshot");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Tool trace persistence test",
    slug: `tool-trace-persistence-test-${workspaceId}`,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Tool trace persistence test",
  });
}, 120_000);

afterAll(async () => {
  // Cascade cleanup of the workspace (threads, runs) before the clone is dropped.
  if (schema) {
    await schema.db
      .delete(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${workspaceId}`);
    await schema.database.end();
  }
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

test("a run with 50 tool calls of 100 KB output persists each output once per snapshot", async () => {
  const run = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `tool-trace-persistence:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "search everything",
    },
  });
  assert.ok(run);
  const running = await repository.markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.ok(running);
  assert.equal(running.status, "running");

  // Synthetic run: 50 tool calls, each streamed as the durable runner sees
  // them (start → result → end, with the full toolCall record repeated on the
  // result and end events) and each returning a 100 KB text output. Flushed
  // through the repository every ten calls, as the runner flushes mid-run.
  const toolCount = 50;
  const outputChars = 100_000;
  const outputFor = (index: number) =>
    `${index}:`.padEnd(outputChars, "o").slice(0, outputChars);
  let snapshot: ChatRunSnapshot = { assistantContent: "" };
  let eventOffset = 0;
  for (let index = 0; index < toolCount; index++) {
    const id = `tool-${index + 1}`;
    const output = { text: outputFor(index) };
    const toolCall = (status: "running" | "completed") => ({
      id,
      tool: "search_notion_pages",
      input: { query: `q${index}` },
      output: status === "running" ? null : output,
      status,
      latencyMs: status === "running" ? null : 12,
      error: null,
      sequence: index + 1,
    });
    snapshot = runner.testExports.updateSnapshotFromPayload(snapshot, {
      type: "tool-call-start",
      id,
      tool: "search_notion_pages",
      input: { query: `q${index}` },
      toolCall: toolCall("running"),
    });
    snapshot = runner.testExports.updateSnapshotFromPayload(snapshot, {
      type: "tool-call-result",
      id,
      tool: "search_notion_pages",
      output,
      latencyMs: 12,
      toolCall: toolCall("completed"),
    });
    snapshot = runner.testExports.updateSnapshotFromPayload(snapshot, {
      type: "tool-call-end",
      id,
      tool: "search_notion_pages",
      status: "completed",
      latencyMs: 12,
      toolCall: toolCall("completed"),
    });
    eventOffset += 3;
    if (index % 10 === 9) {
      await repository.updateChatThreadRunProgress({
        runId: run.id,
        teamId,
        workspaceId,
        eventOffset,
        snapshotJson: snapshot,
        returnRecord: false,
      });
    }
  }

  const [row] = (
    await schema.db.execute(sql`
      select
        octet_length(snapshot_json::text) as snapshot_bytes,
        octet_length((snapshot_json->'traceEvents')::text) as trace_event_bytes,
        jsonb_array_length(snapshot_json->'traceEvents') as trace_events,
        jsonb_array_length(snapshot_json->'toolCalls') as tool_calls
      from chat_thread_runs
      where id = ${run.id}
    `)
  ).rows as Array<{
    snapshot_bytes: number | string;
    trace_event_bytes: number | string;
    trace_events: number | string;
    tool_calls: number | string;
  }>;
  assert.ok(row);
  assert.equal(Number(row.tool_calls), toolCount);
  assert.equal(Number(row.trace_events), toolCount * 3);

  // This fixture has no embedded assistantMessage (the runner embeds it only
  // at the end of a run), so the row holds exactly one copy of every output:
  // `toolCalls[id].output`. The bound leaves 25% for structure, not for a
  // second copy. The embedded assistant-message copy — the second full copy
  // in a real terminal snapshot — is out of this test's scope.
  const outputBytes = toolCount * outputChars;
  const snapshotBytes = Number(row.snapshot_bytes);
  assert.ok(
    snapshotBytes < outputBytes * 1.25,
    `snapshot_json is ${snapshotBytes} bytes for ${outputBytes} bytes of tool output`,
  );
  // The trace events themselves stay output-free: under 2 KB per event.
  const traceEventBytes = Number(row.trace_event_bytes);
  assert.ok(
    traceEventBytes < toolCount * 3 * 2_048,
    `traceEvents are ${traceEventBytes} bytes for ${toolCount * 3} events`,
  );

  const persisted = await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  });
  const persistedSnapshot = persisted?.snapshotJson as ChatRunSnapshot;
  for (let index = 0; index < toolCount; index++) {
    const id = `tool-${index + 1}`;
    const toolCall = (persistedSnapshot.toolCalls ?? [])
      .map(snapshotModule.toToolCallTrace)
      .find((record) => record?.id === id);
    assert.ok(toolCall, `${id} missing from persisted toolCalls`);
    assert.equal(toolCall.status, "completed");
    assert.equal(
      (toolCall.output as { text?: string } | null)?.text,
      outputFor(index),
      `${id} output is not the full ${outputChars} chars`,
    );
  }
  for (const event of persistedSnapshot.traceEvents ?? []) {
    const record = event as Record<string, unknown>;
    assert.equal(record.type, "tool-call");
    assert.equal("payload" in record, false);
    const serialized = JSON.stringify(record);
    assert.ok(
      serialized.length < 2_048,
      `${record.id} is ${serialized.length}`,
    );
    assert.doesNotMatch(serialized, /oooooooooo/);
  }
  // Tool trace parts are output-free too; readers resolve output by toolCallId.
  assert.equal((persistedSnapshot.traceParts ?? []).length, toolCount);
  assert.doesNotMatch(
    JSON.stringify(persistedSnapshot.traceParts),
    /oooooooooo/,
  );

  // The assistant message metadata the runner embeds back into the snapshot
  // at the end of the run is bounded the same way: output once, in toolCalls.
  const metadata = runner.testExports.buildSnapshotMetadata({
    currentMetadata: {},
    run: running,
    snapshot: persistedSnapshot,
  });
  const metadataBytes = JSON.stringify(metadata).length;
  assert.ok(
    metadataBytes < outputBytes * 1.25,
    `assistant metadata is ${metadataBytes} bytes for ${outputBytes} bytes of tool output`,
  );
});

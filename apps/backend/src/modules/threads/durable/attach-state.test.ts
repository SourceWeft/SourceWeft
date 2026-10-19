import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { resolveAttachRunState } from "./run-results";
import { finishRunIfSnapshotIsTerminalWithDependencies } from "./run-recovery";
import type { ChatThreadRunAttachState } from "./repository";
import type { ChatThreadRunRecord } from "./types";
import { parseSsePayload } from "./run-state";
import {
  ORPHANED_QUEUED_RUN_GRACE_MS,
  SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS,
} from "./run-constants";

const now = Date.parse("2026-10-16T00:00:00Z");
const iso = (age = 0) => new Date(now - age).toISOString();
afterEach(() => vi.restoreAllMocks());
function createRun(
  input: Partial<ChatThreadRunRecord> = {},
): ChatThreadRunRecord {
  return {
    id: "run",
    teamId: "team",
    workspaceId: "workspace",
    threadId: "thread",
    userId: "owner",
    userMessageId: "user",
    assistantMessageId: "assistant",
    idempotencyKey: "key",
    mode: "send",
    jobId: "job",
    streamKey: "stream",
    status: "running",
    eventOffset: 1,
    requestJson: {},
    snapshotJson: {},
    errorCode: null,
    errorMessage: null,
    startedAt: iso(),
    heartbeatAt: iso(),
    finishedAt: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...input,
  };
}
function control(run: ChatThreadRunRecord): ChatThreadRunAttachState {
  const {
    status,
    jobId,
    streamKey,
    eventOffset,
    errorCode,
    errorMessage,
    startedAt,
    heartbeatAt,
    createdAt,
    updatedAt,
  } = run;
  return {
    status,
    jobId,
    streamKey,
    eventOffset,
    errorCode,
    errorMessage,
    startedAt,
    heartbeatAt,
    createdAt,
    updatedAt,
  };
}
const scope = { runId: "run", teamId: "team", workspaceId: "workspace" };

test.each(["queued", "running", "cancel_requested"] as const)(
  "fresh %s attach polls only scoped control fields and preserves Redis offset handling",
  async (status) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const old = createRun({
      snapshotJson: { large: "x".repeat(5 * 1024 * 1024) },
      heartbeatAt: iso(20 * 60_000),
    });
    const fresh = createRun({
      status,
      eventOffset: 123,
      streamKey: "fresh-stream",
      heartbeatAt: iso(1),
    });
    const narrow = vi.fn(async () => control(fresh));
    const full = vi.fn(async () => {
      throw Error("full payload must not be read");
    });
    const recovery = vi.fn(async () => {
      throw Error("live recovery must not run");
    });
    const events = vi.fn(async () => {
      throw Error("active path must not replay terminal events");
    });
    const result = await resolveAttachRunState({
      run: old,
      offset: 43,
      sawErrorEvent: true,
      findAttachState: narrow,
      findRunById: full,
      failStaleRun: recovery,
      getEvents: events,
    });
    assert.deepEqual(narrow.mock.calls, [[scope]]);
    assert.equal(full.mock.calls.length, 0);
    assert.equal(recovery.mock.calls.length, 0);
    assert.equal(events.mock.calls.length, 0);
    assert.equal(result.run.snapshotJson, old.snapshotJson);
    assert.equal(result.run.status, status);
    assert.equal(result.run.eventOffset, 123);
    assert.equal(result.run.streamKey, "fresh-stream");
    assert.equal(result.terminalEvents, null);
    assert.equal(result.sawErrorEvent, true);
  },
);

test.each([
  [
    "worker grace boundary",
    { heartbeatAt: iso(SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS) },
  ],
  [
    "worker grace elapsed",
    { heartbeatAt: iso(SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS + 1) },
  ],
  [
    "orphan queued beyond grace",
    {
      status: "queued",
      jobId: null,
      createdAt: iso(ORPHANED_QUEUED_RUN_GRACE_MS + 1),
    },
  ],
  ["waiting approval with fresh heartbeat", { status: "waiting_for_approval" }],
  [
    "unparseable timestamps",
    {
      heartbeatAt: null,
      updatedAt: "invalid",
      startedAt: null,
      createdAt: "invalid",
    },
  ],
] satisfies Array<[string, Partial<ChatThreadRunRecord>]>)(
  "%s retains full snapshot recovery",
  async (_label, change) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const latest = createRun({
      ...change,
      snapshotJson: { latestSnapshot: true },
    });
    const full = vi.fn(async () => latest);
    const recovered: ChatThreadRunRecord[] = [];
    const result = await resolveAttachRunState({
      run: createRun(),
      offset: 43,
      sawErrorEvent: false,
      findAttachState: async (input) => {
        assert.deepEqual(input, scope);
        return control(latest);
      },
      findRunById: full,
      failStaleRun: async (run) => {
        recovered.push(run);
        return run;
      },
    });
    assert.deepEqual(full.mock.calls, [[scope]]);
    assert.deepEqual(recovered, [latest]);
    assert.equal(result.run, latest);
    assert.equal(result.terminalEvents, null);
  },
);

test("orphan queue at its exact grace and live worker just inside grace stay narrow", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const run = createRun({
    status: "queued",
    jobId: null,
    createdAt: iso(ORPHANED_QUEUED_RUN_GRACE_MS),
    heartbeatAt: iso(SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS - 1),
  });
  const result = await resolveAttachRunState({
    run,
    offset: 0,
    sawErrorEvent: false,
    findAttachState: async (input) => {
      assert.deepEqual(input, scope);
      return control(run);
    },
    findRunById: async () => {
      throw Error("must stay narrow");
    },
  });
  assert.equal(result.terminalEvents, null);
});

test("missing scoped projection retains the existing missing-full fallback", async () => {
  const run = createRun();
  const full = vi.fn(async () => null);
  let recovered: ChatThreadRunRecord | undefined;
  const result = await resolveAttachRunState({
    run,
    offset: 0,
    sawErrorEvent: false,
    findAttachState: async (input) => {
      assert.deepEqual(input, scope);
      return null;
    },
    findRunById: full,
    failStaleRun: async (current) => {
      recovered = current;
      return current;
    },
  });
  assert.deepEqual(full.mock.calls, [[scope]]);
  assert.equal(recovered, run);
  assert.equal(result.run, run);
});

test("lost heartbeat still loads the latest finished snapshot and recovers before terminal replay", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const latest = createRun({
    heartbeatAt: iso(SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS),
    snapshotJson: { finishReason: "stop" },
  });
  const completed = { ...latest, status: "completed" as const };
  const finishes: unknown[] = [];
  const result = await resolveAttachRunState({
    run: createRun(),
    offset: 7,
    sawErrorEvent: false,
    findAttachState: async () => control(latest),
    findRunById: async () => latest,
    failStaleRun: (run) =>
      finishRunIfSnapshotIsTerminalWithDependencies(run, {
        nowMs: now,
        finishRun: async (input) => {
          finishes.push(input);
          return completed;
        },
        findRunById: async () => completed,
        updateAssistantMetadata: async () => null,
      }),
    getEvents: async () => ({ events: [], nextOffset: 7 }),
  });
  assert.equal(finishes.length, 1);
  assert.equal(result.run.status, "completed");
  assert.deepEqual(result.terminalEvents?.map(parseSsePayload), [
    { type: "finish" },
  ]);
});

test.each(["completed", "failed", "cancelled"] as const)(
  "terminal %s reloads full state and replays from the exact offset",
  async (status) => {
    const run = createRun({
      status,
      errorCode: "PERSISTED_ERROR",
      errorMessage: "Persisted failure",
      streamKey: "latest-stream",
    });
    const full = vi.fn(async () => run);
    const reads: unknown[] = [];
    const result = await resolveAttachRunState({
      run: createRun(),
      offset: 43,
      sawErrorEvent: false,
      findAttachState: async () => control(run),
      findRunById: full,
      failStaleRun: async (current) => current,
      getEvents: async (key, offset) => {
        reads.push([key, offset]);
        return { events: [], nextOffset: offset };
      },
    });
    assert.deepEqual(full.mock.calls, [[scope]]);
    assert.deepEqual(reads, [["latest-stream", 43]]);
    const payloads = result.terminalEvents!.map(parseSsePayload);
    assert.equal(payloads.at(-1)?.type, "finish");
    if (status !== "completed") {
      assert.equal(payloads[0]?.code, "PERSISTED_ERROR");
      assert.equal(payloads[0]?.error, "Persisted failure");
    }
  },
);

test("existing terminal error and finish replay without duplication", async () => {
  const run = createRun({ status: "failed" });
  const error = 'data: {"type":"error","code":"ORIGINAL"}\n\n';
  const finish = 'data: {"type":"finish"}\n\n';
  const result = await resolveAttachRunState({
    run,
    offset: 2,
    sawErrorEvent: false,
    findAttachState: async () => control(run),
    findRunById: async () => run,
    failStaleRun: async (current) => current,
    getEvents: async () => ({
      events: [
        { kind: "sse", payload: error, createdAt: iso() },
        { kind: "sse", payload: finish, createdAt: iso() },
      ],
      nextOffset: 4,
    }),
  });
  assert.equal(result.sawErrorEvent, true);
  assert.deepEqual(result.terminalEvents, [error, finish]);
});

test("previously seen error suppresses synthesized duplicate error", async () => {
  const run = createRun({ status: "cancelled" });
  const result = await resolveAttachRunState({
    run,
    offset: 9,
    sawErrorEvent: true,
    findAttachState: async () => control(run),
    findRunById: async () => run,
    failStaleRun: async (current) => current,
    getEvents: async () => ({ events: [], nextOffset: 9 }),
  });
  assert.deepEqual(result.terminalEvents?.map(parseSsePayload), [
    { type: "finish" },
  ]);
});

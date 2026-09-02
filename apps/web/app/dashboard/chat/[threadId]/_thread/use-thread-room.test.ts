import assert from "node:assert/strict";
import { test } from "vitest";
import {
  artifactOutputTargetFromRoomFrame,
  mergeArtifactOutputTarget,
  reconcileRoomRun,
  shouldClearAdoptedRun,
} from "./use-thread-room";
import type { ActiveThreadRun } from "../chat-stream-runner-control";

function run(overrides: Partial<ActiveThreadRun> = {}): ActiveThreadRun {
  return {
    idempotencyKey: "run-key",
    status: "running",
    userId: "user-1",
    ...overrides,
  };
}

test("the same run only advances status and keeps the richer local copy", () => {
  const current = run({ status: "queued", assistantMessageId: "assistant-1" });
  const incoming = run({ status: "running" });

  const result = reconcileRoomRun({ current, incoming, attachedRunKey: null });

  assert.equal(result.status, "running");
  // The local copy carried an assistantMessageId the room frame didn't — keep it.
  assert.equal(result.assistantMessageId, "assistant-1");
});

test("the same run at the same status returns the identical object (no churn)", () => {
  const current = run({ status: "running" });

  const result = reconcileRoomRun({
    current,
    incoming: run({ status: "running" }),
    attachedRunKey: null,
  });

  assert.equal(result, current);
});

test("a run we attach/drive is never modified by a room frame (no status regression)", () => {
  const current = run({
    idempotencyKey: "attached",
    status: "queued",
    assistantMessageId: "assistant-1",
  });
  // A lagging room snapshot for the run we drive — must not touch our state.
  const incoming = run({ idempotencyKey: "attached", status: "running" });

  const result = reconcileRoomRun({
    current,
    incoming,
    attachedRunKey: "attached",
  });

  assert.equal(result, current);
  assert.equal(result.status, "queued");
});

test("a different remote run is adopted (so the send-queue engages) with its userId", () => {
  const incoming = run({ idempotencyKey: "theirs", userId: "user-2" });

  const result = reconcileRoomRun({
    current: null,
    incoming,
    attachedRunKey: null,
  });

  assert.equal(result.idempotencyKey, "theirs");
  // userId preserved so owner-aware gating leaves our composer usable.
  assert.equal(result.userId, "user-2");
});

test("an adopted run (not locally driven, not attached) is cleared on run_finished", () => {
  // Another member's run, or our own from a second tab: no local lifecycle
  // clears it, so the room must — else the queue never drains.
  assert.equal(
    shouldClearAdoptedRun({ isLocallyDriven: false, isAttached: false }),
    true,
  );
});

test("a run this tab drives or attaches is left to the local lifecycle", () => {
  assert.equal(
    shouldClearAdoptedRun({ isLocallyDriven: true, isAttached: false }),
    false,
  );
  assert.equal(
    shouldClearAdoptedRun({ isLocallyDriven: false, isAttached: true }),
    false,
  );
});

test("artifact output room frames retain the exact run and assistant target", () => {
  assert.deepEqual(
    artifactOutputTargetFromRoomFrame({
      type: "run",
      kind: "artifact_output",
      runId: "run-1",
      status: "running",
      assistantMessageId: "assistant-1",
    }),
    { runId: "run-1", assistantMessageId: "assistant-1" },
  );
});

// F1: a run's remembered target must not survive into a new run just because
// an update for the new run only carries one identifying field (e.g. an early
// frame that only knows the assistantMessageId yet). Regression coverage for
// use-thread-room.ts's rememberArtifactTarget / reconcileArtifactOutputs.
test("mergeArtifactOutputTarget builds up fields for the same run across calls", () => {
  const withRunId = mergeArtifactOutputTarget(null, { runId: "run-a" });
  assert.deepEqual(withRunId, { runId: "run-a" });

  const withAssistantMessage = mergeArtifactOutputTarget(withRunId, {
    assistantMessageId: "assistant-a",
  });
  assert.deepEqual(withAssistantMessage, {
    runId: "run-a",
    assistantMessageId: "assistant-a",
  });
});

test("mergeArtifactOutputTarget resets on a conflicting assistantMessageId even without a runId on the update", () => {
  const runAComplete = { runId: "run-a", assistantMessageId: "assistant-a" };

  // Run B starts; an early frame only knows its assistantMessageId yet (no
  // runId). Before the fix, the missing runId meant the conflict check never
  // fired, so run A's stale runId got paired with run B's assistantMessageId.
  const result = mergeArtifactOutputTarget(runAComplete, {
    assistantMessageId: "assistant-b",
  });

  // deepEqual pins the exact shape, proving the stale runId did not survive.
  assert.deepEqual(result, { assistantMessageId: "assistant-b" });
});

test("mergeArtifactOutputTarget resets on a conflicting runId even without an assistantMessageId on the update", () => {
  const runAComplete = { runId: "run-a", assistantMessageId: "assistant-a" };

  const result = mergeArtifactOutputTarget(runAComplete, { runId: "run-b" });

  // deepEqual pins the exact shape, proving the stale assistantMessageId did
  // not survive.
  assert.deepEqual(result, { runId: "run-b" });
});

test("mergeArtifactOutputTarget treats a null/undefined field as unknown, never as an explicit clear", () => {
  const current = { runId: "run-a", assistantMessageId: "assistant-a" };

  const result = mergeArtifactOutputTarget(current, {
    runId: "run-a",
    assistantMessageId: null,
  });

  // The room's incoming-run payload can carry assistantMessageId: null before
  // the server assigns one. That must not wipe an assistantMessageId we
  // already remembered for the same run.
  assert.deepEqual(result, current);
});

test("mergeArtifactOutputTarget with no identifying fields on the update is a no-op", () => {
  const current = { runId: "run-a", assistantMessageId: "assistant-a" };

  assert.equal(mergeArtifactOutputTarget(current, null), current);
  assert.equal(mergeArtifactOutputTarget(current, {}), current);
});

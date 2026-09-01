import assert from "node:assert/strict";
import { test } from "vitest";
import {
  artifactOutputTargetFromRoomFrame,
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

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveChatExecutionState,
  resolveComposerRunControl,
  resolveOtherUserRunActive,
  resolveWaitingForApprovalRun,
  type ActiveThreadRun,
} from "./chat-stream-runner-control";

function run(status: ActiveThreadRun["status"]): ActiveThreadRun {
  return {
    idempotencyKey: `run-${status}`,
    status,
  };
}

test("chat execution state follows the active run instead of streaming transport", () => {
  assert.equal(
    resolveChatExecutionState({
      activeThreadRun: null,
      isStopping: false,
    }),
    "idle",
  );
  assert.equal(
    resolveChatExecutionState({
      activeThreadRun: run("running"),
      isStopping: false,
    }),
    "executing",
  );
  assert.equal(
    resolveChatExecutionState({
      activeThreadRun: run("waiting_for_approval"),
      isStopping: false,
    }),
    "waiting_for_approval",
  );
  assert.equal(
    resolveChatExecutionState({
      activeThreadRun: run("cancel_requested"),
      isStopping: false,
    }),
    "stopping",
  );
  assert.equal(
    resolveChatExecutionState({
      activeThreadRun: null,
      isStopping: true,
    }),
    "stopping",
  );
});

test("waiting approval run is created from finish signal when local run is missing", () => {
  assert.deepEqual(
    resolveWaitingForApprovalRun({
      assistantMessageId: "assistant-1",
      current: null,
      durableRunKey: "run-key-1",
      mode: "send",
      threadRunId: null,
    }),
    {
      assistantMessageId: "assistant-1",
      idempotencyKey: "run-key-1",
      mode: "send",
      status: "waiting_for_approval",
    },
  );
});

test("waiting approval run updates only the matching active run", () => {
  assert.deepEqual(
    resolveWaitingForApprovalRun({
      assistantMessageId: "assistant-next",
      current: {
        assistantMessageId: "assistant-current",
        id: "run-current",
        idempotencyKey: "run-key-current",
        status: "running",
      },
      durableRunKey: "run-key-next",
      threadRunId: "run-next",
    }),
    {
      assistantMessageId: "assistant-current",
      id: "run-current",
      idempotencyKey: "run-key-current",
      status: "running",
    },
  );

  assert.deepEqual(
    resolveWaitingForApprovalRun({
      assistantMessageId: "assistant-next",
      current: {
        assistantMessageId: "assistant-current",
        idempotencyKey: "run-key-current",
        status: "running",
      },
      durableRunKey: "run-key-current",
      threadRunId: "run-current",
    }),
    {
      assistantMessageId: "assistant-next",
      id: "run-current",
      idempotencyKey: "run-key-current",
      status: "waiting_for_approval",
    },
  );
});

test("Stop stays visible while the session user id is still loading", () => {
  const theirs: ActiveThreadRun = { ...run("running"), userId: "user-2" };

  // Session loading: the current user is unknown, so the run may be ours.
  for (const currentUserId of [null, undefined]) {
    assert.equal(
      resolveOtherUserRunActive({
        activeThreadRun: theirs,
        currentUserId,
        sessionPending: true,
      }),
      false,
    );
  }
  // Session settled without a user (signed out / read failed): not ours.
  assert.equal(
    resolveOtherUserRunActive({
      activeThreadRun: theirs,
      currentUserId: null,
      sessionPending: false,
    }),
    true,
  );
  // Once the user id is known, another member's run is still followed only.
  assert.equal(
    resolveOtherUserRunActive({
      activeThreadRun: theirs,
      currentUserId: "user-1",
      sessionPending: false,
    }),
    true,
  );
  assert.equal(
    resolveOtherUserRunActive({
      activeThreadRun: theirs,
      currentUserId: "user-2",
      sessionPending: false,
    }),
    false,
  );
  // An unattributed (optimistic) run is ours.
  assert.equal(
    resolveOtherUserRunActive({
      activeThreadRun: run("running"),
      currentUserId: null,
      sessionPending: false,
    }),
    false,
  );
  assert.equal(
    resolveOtherUserRunActive({
      activeThreadRun: null,
      currentUserId: null,
      sessionPending: true,
    }),
    false,
  );
});

test("composer holds a pending Stop, never Send, while the active run is unknown", () => {
  assert.equal(
    resolveComposerRunControl({
      activeRunLookupPending: true,
      chatExecutionState: "idle",
      otherUserRunActive: false,
    }),
    "pending-stop",
  );
  // The canvas may not receive an execution state yet (treated as idle).
  assert.equal(
    resolveComposerRunControl({
      activeRunLookupPending: true,
      chatExecutionState: undefined,
      otherUserRunActive: false,
    }),
    "pending-stop",
  );
});

test("composer resolves the lookup to Stop for our run and Send for none", () => {
  for (const chatExecutionState of ["executing", "stopping"] as const) {
    for (const activeRunLookupPending of [true, false]) {
      assert.equal(
        resolveComposerRunControl({
          activeRunLookupPending,
          chatExecutionState,
          otherUserRunActive: false,
        }),
        "stop",
      );
    }
  }
  assert.equal(
    resolveComposerRunControl({
      activeRunLookupPending: false,
      chatExecutionState: "idle",
      otherUserRunActive: false,
    }),
    "send",
  );
  // A new-chat canvas has no thread lookup at all.
  assert.equal(
    resolveComposerRunControl({
      activeRunLookupPending: false,
      chatExecutionState: undefined,
      otherUserRunActive: false,
    }),
    "send",
  );
});

test("composer keeps Send for another member's run and an approval wait", () => {
  for (const activeRunLookupPending of [true, false]) {
    assert.equal(
      resolveComposerRunControl({
        activeRunLookupPending,
        chatExecutionState: "executing",
        otherUserRunActive: true,
      }),
      "send",
    );
    assert.equal(
      resolveComposerRunControl({
        activeRunLookupPending,
        chatExecutionState: "waiting_for_approval",
        otherUserRunActive: false,
      }),
      "send",
    );
  }
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveChatExecutionState,
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

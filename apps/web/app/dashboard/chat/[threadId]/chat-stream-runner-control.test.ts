import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveChatExecutionState,
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

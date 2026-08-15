import assert from "node:assert/strict";
import { test } from "vitest";
import type { AsyncRunStatus } from "./types";
import {
  canTransition,
  isTerminalRunStatus,
  resolveMultitask,
  TERMINAL_RUN_STATUSES,
} from "./run-state";

test("terminal statuses are terminal and never transition", () => {
  for (const status of TERMINAL_RUN_STATUSES) {
    assert.equal(isTerminalRunStatus(status), true);
    for (const to of [
      "pending",
      "running",
      "success",
    ] as AsyncRunStatus[]) {
      assert.equal(
        canTransition(status, to),
        false,
        `${status} → ${to} must be blocked`,
      );
    }
  }
});

test("valid lifecycle transitions are allowed", () => {
  assert.equal(canTransition("pending", "running"), true);
  assert.equal(canTransition("pending", "cancelled"), true);
  assert.equal(canTransition("running", "success"), true);
  assert.equal(canTransition("running", "error"), true);
  assert.equal(canTransition("running", "timeout"), true);
  assert.equal(canTransition("running", "interrupted"), true);
});

test("invalid transitions are blocked", () => {
  assert.equal(canTransition("pending", "success"), false);
  assert.equal(canTransition("running", "pending"), false);
  assert.equal(isTerminalRunStatus("running"), false);
  assert.equal(isTerminalRunStatus("pending"), false);
});

test("resolveMultitask: no active run always starts", () => {
  for (const strategy of ["reject", "interrupt", "rollback", "enqueue"] as const) {
    assert.deepEqual(
      resolveMultitask({ activeRun: null, strategy }),
      { kind: "start" },
    );
  }
});

test("resolveMultitask: a terminal 'active' run always starts", () => {
  assert.deepEqual(
    resolveMultitask({
      activeRun: { runId: "r1", status: "success" },
      strategy: "reject",
    }),
    { kind: "start" },
  );
});

test("resolveMultitask: interrupt supersedes the active run (deepagents update path)", () => {
  assert.deepEqual(
    resolveMultitask({
      activeRun: { runId: "r1", status: "running" },
      strategy: "interrupt",
    }),
    { kind: "interrupt", supersededRunId: "r1" },
  );
});

test("resolveMultitask: each strategy on a live run", () => {
  const activeRun = { runId: "r1", status: "running" as AsyncRunStatus };
  assert.deepEqual(resolveMultitask({ activeRun, strategy: "reject" }), {
    kind: "reject",
    activeRunId: "r1",
  });
  assert.deepEqual(resolveMultitask({ activeRun, strategy: "rollback" }), {
    kind: "rollback",
    discardedRunId: "r1",
  });
  assert.deepEqual(resolveMultitask({ activeRun, strategy: "enqueue" }), {
    kind: "enqueue",
    afterRunId: "r1",
  });
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { presentThreadRunSummary } from "./threads";

function runRow(status: string) {
  return {
    id: "run-1",
    idempotencyKey: "key-1",
    status,
    mode: "send" as const,
    userId: "user-1",
    userMessageId: "msg-1",
    assistantMessageId: null,
  };
}

test("presentThreadRunSummary reports terminal run states as-is", () => {
  // Previously every non-active status collapsed to "queued", so a finished run
  // was reported to clients as still waiting to start.
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(presentThreadRunSummary(runRow(status)).status, status);
  }
});

test("presentThreadRunSummary preserves in-flight run states", () => {
  for (const status of [
    "queued",
    "running",
    "cancel_requested",
    "waiting_for_approval",
  ]) {
    assert.equal(presentThreadRunSummary(runRow(status)).status, status);
  }
});

test("presentThreadRunSummary falls back to queued for unknown states", () => {
  assert.equal(presentThreadRunSummary(runRow("not-a-status")).status, "queued");
});

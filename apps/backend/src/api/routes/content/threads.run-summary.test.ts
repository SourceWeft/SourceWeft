import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { presentThreadRunSummary } from "./threads";

// ./threads pulls in the auth-session middleware, whose module constructs the
// better-auth instance; the oauth-provider plugin then seeds resources into
// PostgreSQL. This file tests a pure presenter and must not open a connection.
vi.mock("../../../modules/auth", () => ({
  auth: {},
  getSession: async () => null,
}));

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

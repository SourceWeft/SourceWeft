import assert from "node:assert/strict";
import { test } from "vitest";
import { NOTIFICATION_KINDS, notificationPath } from "./kinds";

test("a failed background generation leads to its conversation and is never mailed", () => {
  const item = (payload: Record<string, string | boolean>) => ({
    kind: "artifact_generation_failed",
    ref: { kind: "artifact", id: "a1" },
    payload,
  });
  assert.equal(
    notificationPath(item({ title: "Quiz", threadId: "th 1" })),
    "/dashboard/chat/th%201",
  );
  assert.equal(notificationPath(item({ title: "Quiz" })), "/dashboard/chat");
  assert.equal(NOTIFICATION_KINDS.artifact_generation_failed.template, null);
  assert.equal(NOTIFICATION_KINDS.artifact_generation_failed.defaultEmail, false);
});

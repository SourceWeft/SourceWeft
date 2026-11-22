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

test("assistant notifications lead to the assistant, on the ticket when there is one", () => {
  const item = (kind: string, payload: Record<string, string>) => ({
    kind,
    ref: { kind: "assistant_ticket", id: "t1" },
    payload,
  });
  assert.equal(
    notificationPath(item("assistant_question", { ticketId: "t 1" })),
    "/dashboard/assistant?ticket=t%201",
  );
  assert.equal(
    notificationPath(item("assistant_ticket_blocked", { ticketId: "t1" })),
    "/dashboard/assistant?ticket=t1",
  );
  assert.equal(
    notificationPath(item("assistant_unavailable", { assistantId: "a1" })),
    "/dashboard/assistant",
  );
  assert.equal(
    notificationPath(item("assistant_reply", { assistantId: "a1" })),
    "/dashboard/assistant",
  );
  // A reply is right there in the feed: never mailed.
  assert.equal(NOTIFICATION_KINDS.assistant_reply.template, null);
  assert.equal(NOTIFICATION_KINDS.assistant_reply.defaultEmail, false);
  for (const kind of [
    "assistant_question",
    "assistant_ticket_blocked",
    "assistant_unavailable",
  ] as const) {
    assert.equal(NOTIFICATION_KINDS[kind].defaultEmail, true);
    assert.ok(NOTIFICATION_KINDS[kind].template);
  }
});

test("a blocked-assistant mail about no ticket names the payer's messages, in every locale", () => {
  const fallback = (
    NOTIFICATION_KINDS.assistant_ticket_blocked as {
      fallbackName?: Record<string, string>;
    }
  ).fallbackName;
  assert.ok(fallback);
  for (const locale of ["en", "zh-CN", "zh-TW"]) assert.ok(fallback[locale]);
});

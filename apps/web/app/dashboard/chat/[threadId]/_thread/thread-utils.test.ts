import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "../streaming-assistant-state";
import {
  getThreadBootstrapKey,
  resolveAttachOnlyAssistantMessage,
  shouldResetThreadLocalState,
} from "./thread-utils";

function createAssistantMessage(
  id: string,
  createdAtMs: number,
  metadata: Record<string, unknown> = {},
): ChatMessageItem {
  return {
    id,
    role: "assistant",
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

test("attach-only approval resumes from the requested assistant message", () => {
  const messages: ChatMessageItem[] = [
    createAssistantMessage("assistant-approved", 0, {
      thinkingSteps: [{ id: "pre-approval-step" }],
    }),
    createAssistantMessage("assistant-latest", 1, {
      thinkingSteps: [{ id: "unrelated-latest-step" }],
    }),
  ];

  const message = resolveAttachOnlyAssistantMessage({
    assistantMessageId: "assistant-approved",
    messages,
  });

  assert.equal(message?.id, "assistant-approved");
});

test("attach-only approval falls back to the latest assistant message", () => {
  const messages: ChatMessageItem[] = [
    createAssistantMessage("assistant-old", 0),
    createAssistantMessage("assistant-latest", 1),
  ];

  const message = resolveAttachOnlyAssistantMessage({
    assistantMessageId: "assistant-missing",
    messages,
  });

  assert.equal(message?.id, "assistant-latest");
});

test("thread bootstrap key uses workspace and thread id", () => {
  assert.equal(
    getThreadBootstrapKey("workspace-1", "thread-1"),
    "workspace-1:thread-1",
  );
  assert.equal(getThreadBootstrapKey(null, "thread-1"), null);
});

test("thread local reset is skipped after current thread bootstrap", () => {
  assert.equal(
    shouldResetThreadLocalState({
      bootstrappedThreadKey: "workspace-1:thread-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
    }),
    false,
  );
});

test("thread local reset runs before bootstrap or for a different target", () => {
  assert.equal(
    shouldResetThreadLocalState({
      bootstrappedThreadKey: null,
      threadId: "thread-1",
      workspaceId: "workspace-1",
    }),
    true,
  );
  assert.equal(
    shouldResetThreadLocalState({
      bootstrappedThreadKey: "workspace-1:thread-previous",
      threadId: "thread-next",
      workspaceId: "workspace-1",
    }),
    true,
  );
  assert.equal(
    shouldResetThreadLocalState({
      bootstrappedThreadKey: "workspace-previous:thread-1",
      threadId: "thread-1",
      workspaceId: "workspace-next",
    }),
    true,
  );
});

import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "../streaming-assistant-state";
import { resolveAttachOnlyAssistantMessage } from "./thread-utils";

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

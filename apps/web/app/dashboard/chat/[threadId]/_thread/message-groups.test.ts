import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "../streaming-assistant-state";
import { buildVersionedMessageGroups } from "./message-groups";

function createMessage(
  overrides: Partial<ChatMessageItem> & Pick<ChatMessageItem, "id" | "role">,
): ChatMessageItem {
  return {
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("message grouping collapses duplicate message ids before versioning", () => {
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "Create a Notion page",
  });
  const interruptedAssistant = createMessage({
    id: "assistant-1",
    role: "assistant",
    content: "Waiting for confirmation",
    metadata: {
      userMessageId: "user-1",
      sourceUserMessageId: "user-1",
      finishReason: "tool_confirmation_requested",
    },
  });
  const resumedAssistant = createMessage({
    ...interruptedAssistant,
    content: "Created the Notion page",
    metadata: {
      ...interruptedAssistant.metadata,
      finishReason: "stop",
    },
  });

  const groups = buildVersionedMessageGroups([
    userMessage,
    interruptedAssistant,
    resumedAssistant,
  ]);

  const assistantGroup = groups.find((group) => group.role === "assistant");
  assert.equal(assistantGroup?.versions.length, 1);
  assert.equal(assistantGroup?.versions[0]?.id, "assistant-1");
  assert.equal(assistantGroup?.versions[0]?.content, "Created the Notion page");
});

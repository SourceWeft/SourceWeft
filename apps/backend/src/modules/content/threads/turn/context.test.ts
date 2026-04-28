import assert from "node:assert/strict";
import test from "node:test";
import { resolveSourceIdsFromMessage } from "./context";
import type { MessageRecord } from "../../types";

function message(metadata: Record<string, unknown>): MessageRecord {
  return {
    id: "message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role: "user",
    content: "hello",
    metadata,
    createdBy: "user-1",
    model: null,
    creditsConsumed: null,
    createdAt: new Date().toISOString(),
  };
}

test("resolveSourceIdsFromMessage reads source ids", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(
      message({
        sourceIds: ["source-from-message"],
      }),
    ),
    ["source-from-message"],
  );
});

test("resolveSourceIdsFromMessage filters invalid values", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(message({ sourceIds: ["source-1", "", 1] })),
    ["source-1"],
  );
});

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

test("resolveSourceIdsFromMessage prefers retrieval source ids", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(
      message({
        sourceIds: ["source-from-message"],
        selectedSourceIds: ["source-from-selection"],
        retrievalSourceIds: ["source-from-retrieval"],
      }),
    ),
    ["source-from-retrieval"],
  );
});

test("resolveSourceIdsFromMessage falls back to selected and source ids", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(
      message({
        sourceIds: ["source-from-message"],
        selectedSourceIds: ["source-from-selection"],
      }),
    ),
    ["source-from-selection"],
  );

  assert.deepEqual(
    resolveSourceIdsFromMessage(message({ sourceIds: ["source-from-message"] })),
    ["source-from-message"],
  );
});

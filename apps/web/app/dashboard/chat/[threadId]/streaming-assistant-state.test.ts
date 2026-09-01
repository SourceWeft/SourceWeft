import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mergeStreamingMessageIntoMessages,
  type ChatMessageItem,
} from "./streaming-assistant-state";

function message(input: {
  id: string;
  renderBlocks: unknown[];
}): ChatMessageItem {
  return {
    id: input.id,
    role: "assistant",
    content: "text",
    contentJson: {},
    parentMessageId: null,
    metadata: { renderBlocks: input.renderBlocks },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

test("a later streaming snapshot cannot erase a reconciled artifact output", () => {
  const artifactOutput = {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    id: "artifact-output:run-1:artifact-1:version-1",
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
    sourceToolCallId: "tool-1",
    threadRunId: "run-1",
    type: "artifact_output",
  };
  const base = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
  });
  const streaming = message({
    id: "assistant-1",
    renderBlocks: [{ id: "text-live", type: "text", text: "new token" }],
  });

  const merged = mergeStreamingMessageIntoMessages([base], {
    message: streaming,
    messageId: "assistant-1",
    messageIds: ["assistant-1"],
    renderVersion: 2,
  });

  assert.deepEqual(merged[0]?.metadata.renderBlocks, [
    { id: "text-live", type: "text", text: "new token" },
    artifactOutput,
  ]);
});

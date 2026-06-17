import assert from "node:assert/strict";
import { test } from "vitest";
import { buildMessageRenderState } from "./message-render-state";
import type { CitationRecord, MessageVersion } from "./types";

function citation(overrides: Partial<CitationRecord> = {}): CitationRecord {
  return {
    citation: "[1]",
    sourceId: "source_1",
    sourceTitle: "Source One",
    documentId: "doc_1",
    chunkId: "chunk_1",
    chunkNo: 1,
    score: 0.9,
    excerpt: "first excerpt",
    ...overrides,
  };
}

function assistantVersion(
  overrides: Partial<MessageVersion> = {},
): MessageVersion {
  return {
    id: "message_1",
    content: "Final answer",
    createdAt: "2026-01-01T00:00:00.000Z",
    renderBlocks: [{ id: "block_text_1", text: "Final answer", type: "text" }],
    ...overrides,
  };
}

test("buildMessageRenderState exposes explicit assistant render fields", () => {
  const state = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version: assistantVersion({
      citations: [citation()],
      threadRun: { status: "completed" },
    }),
  });

  assert.equal(state.role, "assistant");
  assert.equal(state.status, "completed");
  assert.equal(state.text, "Final answer");
  assert.deepEqual(state.bodyBlocks, [
    { id: "block_text_1", text: "Final answer", type: "text" },
  ]);
  assert.equal(state.citations.length, 1);
});

test("buildMessageRenderState revision changes when citation content changes", () => {
  const baseVersion = assistantVersion({
    citations: [citation({ excerpt: "first excerpt" })],
    threadRun: { status: "completed" },
  });
  const nextVersion = assistantVersion({
    citations: [citation({ excerpt: "updated excerpt" })],
    threadRun: { status: "completed" },
  });

  const base = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version: baseVersion,
  });
  const next = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version: nextVersion,
  });

  assert.notEqual(base.renderRevision, next.renderRevision);
});

test("buildMessageRenderState keeps generated artifact blocks as body input", () => {
  const state = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version: assistantVersion({
      content: "![generated image](sandbox:/image.png)",
      renderBlocks: [
        { id: "block_tool_1", toolCallId: "tool_1", type: "generated_image" },
      ],
      toolCalls: [
        {
          id: "tool_1",
          tool: "generate_image",
          input: {},
          output: null,
          latencyMs: 100,
          status: "completed",
          error: null,
        },
      ],
    }),
  });

  assert.deepEqual(state.bodyBlocks, [
    { id: "block_tool_1", toolCallId: "tool_1", type: "generated_image" },
  ]);
});

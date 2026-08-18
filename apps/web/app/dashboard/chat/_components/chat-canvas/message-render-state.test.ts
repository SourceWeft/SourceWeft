import assert from "node:assert/strict";
import { test } from "vitest";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { buildMessageRenderState } from "./message-render-state";
import type { CitationRecord, MessageVersion } from "./types";

const testRenderImageArtifactTool = defineAgentTool({
  id: "testRenderImageArtifact",
  name: "test_render_image_artifact",
  domain: "artifact",
  capabilities: ["artifact", "generated_image_artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: false,
      activates: false,
    },
  },
  slash: {
    displayName: "Test render image artifact",
  },
});

registerAgentTools([testRenderImageArtifactTool]);

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

test("buildMessageRenderState keeps bottom loading visible during paused text output", () => {
  const state = buildMessageRenderState({
    isAssistantStreaming: true,
    role: "assistant",
    version: assistantVersion({
      isTextPaused: true,
      threadRun: { status: "running" },
    }),
  });

  assert.equal(state.shouldShowBottomLoading, true);
});

test("buildMessageRenderState hides bottom loading while waiting for approval", () => {
  const state = buildMessageRenderState({
    isAssistantStreaming: true,
    role: "assistant",
    version: assistantVersion({
      isTextPaused: true,
      threadRun: { status: "waiting_for_approval" },
    }),
  });

  assert.equal(state.shouldShowBottomLoading, false);
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

test("buildMessageRenderState keeps generated artifact blocks and activity tool calls separate", () => {
  const state = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version: assistantVersion({
      content: "![generated image](sandbox:/image.png)",
      renderBlocks: [
        {
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          id: "block_artifact_1",
          placement: "terminal",
          producer: { kind: "main" },
          sequence: 1,
          sourceToolCallId: "tool_1",
          threadRunId: "run-1",
          type: "artifact_output",
        },
      ],
      toolCalls: [
        {
          id: "tool_1",
          tool: "test_render_image_artifact",
          input: {},
          output: null,
          latencyMs: 100,
          status: "completed",
          error: null,
        },
      ],
      traceParts: [
        {
          createdAt: "2026-06-01T00:00:00.000Z",
          id: "trace_tool_1",
          input: { prompt: "draw it" },
          kind: "tool",
          order: 1,
          status: "completed",
          tool: "test_render_image_artifact",
          toolCallId: "tool_1",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    }),
  });

  assert.deepEqual(state.bodyBlocks, [
    {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      id: "block_artifact_1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "tool_1",
      threadRunId: "run-1",
      type: "artifact_output",
    },
  ]);
  assert.equal(state.activityItems[0]?.type, "tool");
  assert.equal(
    state.activityItems[0]?.type === "tool"
      ? state.activityItems[0].toolCall.id
      : null,
    "tool_1",
  );
});

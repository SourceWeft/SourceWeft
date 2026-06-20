import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRenderBlock } from "./types";
import {
  buildAssistantRenderSegments,
  includeGeneratedImageToolInvocationBlocks,
} from "./assistant-render-segments";

function reasoning(id: string): MessageRenderBlock {
  return { id, text: `Reasoning ${id}`, type: "reasoning" };
}

function tool(id: string): MessageRenderBlock {
  return { id, toolCallId: id, type: "tool" };
}

function terminalArtifact(id: string): MessageRenderBlock {
  return {
    id,
    placement: "terminal",
    toolCallId: id,
    type: "generated_presentation",
  };
}

function terminalImageArtifact(id: string): MessageRenderBlock {
  return {
    id,
    placement: "terminal",
    toolCallId: id,
    type: "generated_image",
  };
}

function text(id: string): MessageRenderBlock {
  return { id, text: `Answer ${id}`, type: "text" };
}

function blockSummary(block: MessageRenderBlock) {
  return [
    block.id,
    block.type,
    "toolCallId" in block ? block.toolCallId : null,
  ];
}

test("buildAssistantRenderSegments keeps assistant text visible around workflow", () => {
  const segments = buildAssistantRenderSegments([
    reasoning("reasoning-1"),
    tool("tool-1"),
    text("text-1"),
    reasoning("reasoning-2"),
    tool("tool-2"),
    text("text-2"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "answer", "workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [
      ["reasoning-1", "tool-1"],
      ["text-1"],
      ["reasoning-2", "tool-2"],
      ["text-2"],
    ],
  );
});

test("buildAssistantRenderSegments keeps interrupted output outside workflow", () => {
  const segments = buildAssistantRenderSegments([
    { id: "text-read", text: "Let me read the reference.", type: "text" },
    tool("read"),
    reasoning("thought"),
    { id: "text-plan", text: "I have enough information.", type: "text" },
    tool("write"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["answer", "workflow", "answer", "workflow"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["text-read"], ["read", "thought"], ["text-plan"], ["write"]],
  );
});

test("buildAssistantRenderSegments alternates text and tool segments", () => {
  const segments = buildAssistantRenderSegments([
    text("text-1"),
    tool("tool-1"),
    text("text-2"),
    tool("tool-2"),
    text("text-3"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["answer", "workflow", "answer", "workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["text-1"], ["tool-1"], ["text-2"], ["tool-2"], ["text-3"]],
  );
});

test("buildAssistantRenderSegments keeps trailing text as final answer", () => {
  const segments = buildAssistantRenderSegments(
    [reasoning("reasoning-1"), tool("tool-1"), text("text-1")],
  );

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["reasoning-1", "tool-1"], ["text-1"]],
  );
});

test("buildAssistantRenderSegments places terminal blocks after trailing answer text", () => {
  const segments = buildAssistantRenderSegments([
    reasoning("reasoning-1"),
    terminalArtifact("artifact-1"),
    text("text-1"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "answer", "terminal"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["reasoning-1"], ["text-1"], ["artifact-1"]],
  );
});

test("buildAssistantRenderSegments preserves terminal block order at the end", () => {
  const segments = buildAssistantRenderSegments([
    terminalArtifact("artifact-1"),
    text("text-1"),
    terminalArtifact("artifact-2"),
    text("text-2"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["answer", "terminal"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["text-1", "text-2"], ["artifact-1", "artifact-2"]],
  );
});

test("includeGeneratedImageToolInvocationBlocks adds inline tool rows for terminal image artifacts", () => {
  const blocks = includeGeneratedImageToolInvocationBlocks([
    reasoning("reasoning-1"),
    terminalImageArtifact("image-1"),
    text("text-1"),
  ]);

  assert.deepEqual(
    blocks.map(blockSummary),
    [
      ["reasoning-1", "reasoning", null],
      ["image-1-tool", "tool", "image-1"],
      ["image-1", "generated_image", "image-1"],
      ["text-1", "text", null],
    ],
  );

  const segments = buildAssistantRenderSegments(blocks);
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "answer", "terminal"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["reasoning-1", "image-1-tool"], ["text-1"], ["image-1"]],
  );
});

test("includeGeneratedImageToolInvocationBlocks does not duplicate existing image tool rows", () => {
  const blocks = includeGeneratedImageToolInvocationBlocks([
    tool("image-1"),
    terminalImageArtifact("image-1"),
  ]);

  assert.deepEqual(
    blocks.map(blockSummary),
    [
      ["image-1", "tool", "image-1"],
      ["image-1", "generated_image", "image-1"],
    ],
  );
});

test("buildAssistantRenderSegments leaves workflow blocks between answers inline", () => {
  const segments = buildAssistantRenderSegments([
    text("text-1"),
    tool("tool-1"),
    text("text-2"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["answer", "workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["text-1"], ["tool-1"], ["text-2"]],
  );
});

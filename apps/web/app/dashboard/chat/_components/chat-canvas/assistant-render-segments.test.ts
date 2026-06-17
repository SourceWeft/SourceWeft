import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRenderBlock } from "./types";
import {
  buildAssistantRenderSegments,
  formatWorkedDuration,
  getWorkflowHeaderLabel,
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

function text(id: string): MessageRenderBlock {
  return { id, text: `Answer ${id}`, type: "text" };
}

test("buildAssistantRenderSegments keeps text before later work inside workflow", () => {
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
    ["workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["reasoning-1", "tool-1", "text-1", "reasoning-2", "tool-2"], ["text-2"]],
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

test("buildAssistantRenderSegments leaves unplaced workflow blocks inline", () => {
  const segments = buildAssistantRenderSegments([
    text("text-1"),
    tool("tool-1"),
    text("text-2"),
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "answer"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.blocks.map((block) => block.id)),
    [["text-1", "tool-1"], ["text-2"]],
  );
});

test("formatWorkedDuration keeps minute durations precise to seconds", () => {
  assert.equal(formatWorkedDuration(999), "1s");
  assert.equal(formatWorkedDuration(42_000), "42s");
  assert.equal(formatWorkedDuration(60_000), "1m");
  assert.equal(formatWorkedDuration(92_000), "1m32s");
  assert.equal(formatWorkedDuration(120_000), "2m");
  assert.equal(formatWorkedDuration(151_000), "2m31s");
});

test("getWorkflowHeaderLabel uses Working while running", () => {
  assert.equal(
    getWorkflowHeaderLabel({ durationMs: 92_000, isRunning: true }),
    "Working",
  );
  assert.equal(
    getWorkflowHeaderLabel({ durationMs: 92_000, isRunning: false }),
    "Worked for 1m32s",
  );
  assert.equal(
    getWorkflowHeaderLabel({ durationMs: 0, isRunning: false }),
    "Finished working",
  );
  assert.equal(
    getWorkflowHeaderLabel({ durationMs: null, isRunning: false }),
    "Finished working",
  );
});

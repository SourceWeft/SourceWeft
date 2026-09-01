import assert from "node:assert/strict";
import { test } from "vitest";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { buildAssistantActivityItems } from "./assistant-activity-items";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  TracePartRecord,
} from "./types";

const testGeneratedImageArtifactTool = defineAgentTool({
  id: "testGeneratedImageArtifact",
  name: "test_generated_image_artifact",
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
    displayName: "Test generated image artifact",
  },
});

registerAgentTools([testGeneratedImageArtifactTool]);

test("buildAssistantActivityItems sorts trace parts by order", () => {
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:02.000Z",
      id: "reasoning-late",
      kind: "reasoning",
      order: 3,
      text: "Now answer.",
      updatedAt: "2026-06-01T00:00:02.000Z",
    },
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "step-early",
      items: [],
      kind: "step",
      order: 1,
      status: "completed",
      title: "Reading sources",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  assert.deepEqual(
    buildAssistantActivityItems({ traceParts }).map((item) => item.id),
    ["step-early", "reasoning-late"],
  );
});

test("buildAssistantActivityItems links tool parts with thinking steps", () => {
  const steps: ThinkingStepRecord[] = [
    {
      id: "search-step",
      items: ["Doc A"],
      metadata: { resultCount: 1, toolCallId: "tool-1" },
      status: "completed",
      title: "Searching sources",
    },
  ];
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "tool-part",
      input: { query: "Feynman" },
      kind: "tool",
      order: 2,
      status: "completed",
      tool: "search_sources",
      toolCallId: "tool-1",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  const [item] = buildAssistantActivityItems({ steps, traceParts });

  assert.equal(item?.type, "tool");
  assert.equal(item?.type === "tool" ? item.toolStep?.id : null, "search-step");
});

test("buildAssistantActivityItems keeps generated image artifact tool invocations", () => {
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "image-tool-part",
      input: { prompt: "draw it" },
      kind: "tool",
      order: 1,
      output:
        "Image artifact created.\nartifact_id: artifact-1\nartifact_url: /artifact-preview?artifactId=artifact-1",
      status: "completed",
      tool: "test_generated_image_artifact",
      toolCallId: "image-tool-1",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  const [item] = buildAssistantActivityItems({ traceParts });

  assert.equal(item?.type, "tool");
  assert.equal(
    item?.type === "tool" ? item.toolCall.tool : null,
    "test_generated_image_artifact",
  );
  assert.equal(item?.type === "tool" ? item.toolCall.id : null, "image-tool-1");
});

test("buildAssistantActivityItems prefers trace part status over duplicate tool calls", () => {
  const toolCalls: ToolCallRecord[] = [
    {
      error: null,
      id: "tool-1",
      input: { query: "old" },
      latencyMs: 100,
      output: { resultCount: 1 },
      status: "running",
      tool: "search_sources",
    },
    {
      error: "duplicate should be ignored",
      id: "tool-1",
      input: { query: "duplicate" },
      latencyMs: 999,
      output: null,
      status: "error",
      tool: "search_sources",
    },
  ];
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "tool-part",
      input: { query: "new" },
      kind: "tool",
      order: 1,
      status: "completed",
      tool: "search_sources",
      toolCallId: "tool-1",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  const [item] = buildAssistantActivityItems({ toolCalls, traceParts });

  assert.equal(item?.type, "tool");
  assert.equal(
    item?.type === "tool" ? item.toolCall.status : null,
    "completed",
  );
  assert.deepEqual(item?.type === "tool" ? item.toolCall.output : null, {
    resultCount: 1,
  });
  assert.equal(item?.type === "tool" ? item.toolCall.error : "", null);
});

test("buildAssistantActivityItems keeps reasoning metadata", () => {
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      durationMs: 1200,
      id: "reasoning-1",
      kind: "reasoning",
      order: 1,
      phase: "after_tool",
      text: "The tool result is enough.",
      tool: "search_sources",
      toolCallId: "tool-1",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];

  const [item] = buildAssistantActivityItems({ traceParts });

  assert.equal(item?.type, "reasoning");
  assert.equal(item?.type === "reasoning" ? item.phase : null, "after_tool");
  assert.equal(item?.type === "reasoning" ? item.durationMs : null, 1200);
  assert.equal(item?.type === "reasoning" ? item.toolCallId : null, "tool-1");
});

test("buildAssistantActivityItems excludes reasoning that duplicates final answer text", () => {
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "reasoning-answer",
      kind: "reasoning",
      order: 0,
      phase: "initial",
      text: "Here is the final answer that belongs in the message body.",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      createdAt: "2026-06-01T00:00:01.000Z",
      id: "step-1",
      items: [],
      kind: "step",
      order: 1,
      status: "completed",
      title: "Checked context",
      updatedAt: "2026-06-01T00:00:01.000Z",
    },
  ];

  assert.deepEqual(
    buildAssistantActivityItems({
      assistantText:
        "Here is the final answer that belongs in the message body.",
      traceParts,
    }).map((item) => item.id),
    ["step-1"],
  );
});

test("buildAssistantActivityItems excludes internal citation checking steps", () => {
  const traceParts: TracePartRecord[] = [
    {
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "checking-citations",
      items: [],
      kind: "step",
      order: 1,
      status: "completed",
      title: "Checking citations",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      createdAt: "2026-06-01T00:00:01.000Z",
      id: "search-step",
      items: ["Doc A"],
      kind: "step",
      order: 2,
      status: "completed",
      title: "Searching sources",
      updatedAt: "2026-06-01T00:00:01.000Z",
    },
  ];

  assert.deepEqual(
    buildAssistantActivityItems({ traceParts }).map((item) => item.id),
    ["search-step"],
  );
});

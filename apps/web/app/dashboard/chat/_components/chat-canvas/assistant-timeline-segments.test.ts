import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantActivityItem } from "./assistant-activity-items";
import { buildAssistantTimelineSegments } from "./assistant-timeline-segments";

function reasoning(input: {
  id: string;
  order: number;
  text: string;
}): Extract<AssistantActivityItem, { type: "reasoning" }> {
  return {
    id: input.id,
    key: `part:${input.id}`,
    order: input.order,
    text: input.text,
    type: "reasoning",
  };
}

function tool(input: {
  id: string;
  order: number;
}): Extract<AssistantActivityItem, { type: "tool" }> {
  return {
    id: input.id,
    key: `part:${input.id}`,
    order: input.order,
    toolCall: {
      error: null,
      id: input.id,
      input: {},
      latencyMs: 10,
      output: null,
      status: "completed",
      tool: "search_notion_pages",
    },
    type: "tool",
  };
}

test("buildAssistantTimelineSegments keeps reasoning in workflow activity", () => {
  const segments = buildAssistantTimelineSegments({
    assistantText: "Final answer.",
    items: [
      reasoning({ id: "reasoning-1", order: 1, text: "The skill is installed." }),
      tool({ id: "tool-1", order: 2 }),
      reasoning({ id: "reasoning-2", order: 3, text: "Now let me read the reference." }),
      tool({ id: "tool-2", order: 4 }),
    ],
  });

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "assistant_text"],
  );
  assert.deepEqual(
    segments[0]?.type === "workflow" ? segments[0].items.map((item) => item.id) : [],
    ["reasoning-1", "tool-1", "reasoning-2", "tool-2"],
  );
  const finalSegment = segments.at(-1);
  assert.equal(finalSegment?.type === "assistant_text" ? finalSegment.text : "", "Final answer.");
});

test("buildAssistantTimelineSegments groups consecutive workflow items", () => {
  const segments = buildAssistantTimelineSegments({
    assistantText: "Done.",
    items: [
      reasoning({ id: "reasoning-1", order: 1, text: "Let me search." }),
      tool({ id: "tool-1", order: 2 }),
      tool({ id: "tool-2", order: 3 }),
      tool({ id: "tool-3", order: 4 }),
      reasoning({ id: "reasoning-2", order: 5, text: "I found the pages." }),
    ],
  });

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "assistant_text"],
  );
  assert.deepEqual(
    segments[0]?.type === "workflow" ? segments[0].items.map((item) => item.id) : [],
    ["reasoning-1", "tool-1", "tool-2", "tool-3", "reasoning-2"],
  );
});

test("buildAssistantTimelineSegments skips reasoning duplicated by final answer", () => {
  const segments = buildAssistantTimelineSegments({
    assistantText: "I found the pages.\n\nThe new page has been created.",
    items: [
      reasoning({ id: "reasoning-1", order: 1, text: "I found the pages." }),
      tool({ id: "tool-1", order: 2 }),
    ],
  });

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "assistant_text"],
  );
  const finalSegment = segments.at(-1);
  assert.equal(
    finalSegment?.type === "assistant_text" ? finalSegment.text : "",
    "I found the pages.\n\nThe new page has been created.",
  );
});

test("buildAssistantTimelineSegments places interrupted assistant text before trailing workflow", () => {
  const segments = buildAssistantTimelineSegments({
    assistantText: "Here is the summary.\n\nNow I will create the page.",
    isTextInterrupted: true,
    items: [
      reasoning({ id: "reasoning-1", order: 1, text: "Let me collect the pages." }),
      tool({ id: "search-tool", order: 2 }),
      reasoning({
        id: "reasoning-2",
        order: 3,
        text: "Here is the summary.\n\nNow I will create the page.",
      }),
      tool({ id: "create-tool", order: 4 }),
    ],
  });

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["workflow", "assistant_text", "workflow"],
  );
  assert.deepEqual(
    segments[0]?.type === "workflow" ? segments[0].items.map((item) => item.id) : [],
    ["reasoning-1", "search-tool"],
  );
  assert.equal(
    segments[1]?.type === "assistant_text" ? segments[1].text : "",
    "Here is the summary.\n\nNow I will create the page.",
  );
  assert.deepEqual(
    segments[2]?.type === "workflow" ? segments[2].items.map((item) => item.id) : [],
    ["create-tool"],
  );
});

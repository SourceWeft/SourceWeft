import assert from "node:assert/strict";
import { test } from "vitest";
import { groupConsecutiveToolItems } from "./assistant-activity-groups";
import { buildAssistantActivityItems } from "./assistant-activity-items";
import type { TracePartRecord } from "./types";

function completedToolPart(input: {
  id: string;
  order: number;
  toolCallId: string;
}): Extract<TracePartRecord, { kind: "tool" }> {
  return {
    createdAt: "2026-06-01T00:00:00.000Z",
    id: input.id,
    input: {},
    kind: "tool",
    order: input.order,
    status: "completed",
    tool: "search_notion_pages",
    toolCallId: input.toolCallId,
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

test("groupConsecutiveToolItems keeps ordinary reasoning outside tool groups", () => {
  const items = buildAssistantActivityItems({
    traceParts: [
      completedToolPart({ id: "tool-1-part", order: 1, toolCallId: "tool-1" }),
      {
        createdAt: "2026-06-01T00:00:01.000Z",
        id: "ordinary-reasoning",
        kind: "reasoning",
        order: 2,
        text: "The search for Notion pages returned no results, so I will try a broader search.",
        tool: "search_notion_pages",
        updatedAt: "2026-06-01T00:00:01.000Z",
      },
      completedToolPart({ id: "tool-2-part", order: 3, toolCallId: "tool-2" }),
    ],
  });

  const grouped = groupConsecutiveToolItems(items);

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0]?.type, "tool-group");
  assert.equal(grouped[1]?.type, "reasoning");
  assert.equal(grouped[1]?.id, "ordinary-reasoning");
  assert.equal(grouped[2]?.type, "tool-group");
});

test("groupConsecutiveToolItems nests explicitly tool-owned steps", () => {
  const items = buildAssistantActivityItems({
    traceParts: [
      completedToolPart({ id: "tool-part", order: 1, toolCallId: "tool-1" }),
      {
        createdAt: "2026-06-01T00:00:01.000Z",
        id: "tool-owned-step",
        items: ["listed selected sources"],
        kind: "step",
        metadata: { toolCallId: "tool-1" },
        order: 2,
        status: "completed",
        title: "Listed selected sources",
        updatedAt: "2026-06-01T00:00:01.000Z",
      },
    ],
  });

  const [group] = groupConsecutiveToolItems(items);

  assert.equal(group?.type, "tool-group");
  assert.deepEqual(
    group?.type === "tool-group" ? group.items.map((item) => item.id) : [],
    ["tool-owned-step"],
  );
});

test("groupConsecutiveToolItems keeps tool-associated reasoning with its tool group", () => {
  const items = buildAssistantActivityItems({
    traceParts: [
      completedToolPart({ id: "tool-1-part", order: 1, toolCallId: "tool-1" }),
      {
        createdAt: "2026-06-01T00:00:02.000Z",
        id: "tool-owned-reasoning",
        kind: "reasoning",
        order: 3,
        text: "This note belongs to the tool result.",
        toolCallId: "tool-1",
        updatedAt: "2026-06-01T00:00:02.000Z",
      },
      completedToolPart({ id: "tool-2-part", order: 3, toolCallId: "tool-2" }),
    ],
  });

  const grouped = groupConsecutiveToolItems(items);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.type, "tool-group");
  assert.deepEqual(
    grouped[0]?.type === "tool-group"
      ? grouped[0].items.map((item) => item.id)
      : [],
    ["tool-owned-reasoning", "tool-2-part"],
  );
});

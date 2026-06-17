import assert from "node:assert/strict";
import { test } from "vitest";
import { groupConsecutiveToolItems } from "./assistant-activity-groups";
import { buildAssistantActivityItems } from "./assistant-activity-items";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import {
  getAssistantToolTitle,
  getSkillInstructionReadFileLabel,
  isRedactedSkillInstructionRead,
} from "./assistant-tool-display";
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

test("groupConsecutiveToolItems keeps tool-associated reasoning as its own activity row", () => {
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

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0]?.type, "tool-group");
  assert.equal(grouped[1]?.type, "reasoning");
  assert.equal(grouped[1]?.id, "tool-owned-reasoning");
  assert.equal(grouped[2]?.type, "tool-group");
});

test("assistant activity layout exposes one shared row rail", () => {
  assert.match(ASSISTANT_ACTIVITY_ROW_CLASS, /\bitems-center\b/);
  assert.match(ASSISTANT_ACTIVITY_ROW_CLASS, /\bpx-1\b/);
  assert.match(ASSISTANT_ACTIVITY_ICON_CLASS, /\bsize-6\b/);
  assert.match(ASSISTANT_ACTIVITY_LABEL_CLASS, /\bflex-1\b/);
  assert.match(ASSISTANT_ACTIVITY_DETAIL_CLASS, /\bml-7\b/);
  assert.match(ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS, /\bml-7\b/);
});

test("redacted skill read tools render private skill instruction title", () => {
  const toolCall = {
    error: null,
    id: "call-skill",
    input: {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "Feynman",
      skillSlug: "feynman",
      visibility: "internal_instruction",
    },
    latencyMs: 29,
    output: {
      type: "skill_instruction_read",
      redacted: true,
      skillFileName: "SKILL.md",
      skillPath: "/skills/feynman/SKILL.md",
      content: "must never render",
    },
    status: "completed" as const,
    tool: "read_file",
  };

  assert.equal(isRedactedSkillInstructionRead(toolCall), true);
  assert.equal(
    getAssistantToolTitle(toolCall),
    "Read Feynman skill instructions",
  );
  assert.equal(getSkillInstructionReadFileLabel(toolCall), "SKILL.md");
});

test("running redacted skill read tools render named skill instruction title", () => {
  const toolCall = {
    error: null,
    id: "call-skill-running",
    input: {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "Frontend Design",
      skillFileName: "SKILL.md",
      skillPath: "/skills/frontend-design/SKILL.md",
      skillSlug: "frontend-design",
      visibility: "internal_instruction",
    },
    latencyMs: null,
    output: {
      type: "skill_instruction_read",
      redacted: true,
    },
    status: "running" as const,
    tool: "read_file",
  };

  assert.equal(isRedactedSkillInstructionRead(toolCall), true);
  assert.equal(
    getAssistantToolTitle(toolCall),
    "Reading Frontend Design skill instructions",
  );
  assert.equal(getSkillInstructionReadFileLabel(toolCall), "SKILL.md");
});

test("legacy skill read tool inputs are treated as private instruction reads", () => {
  const toolCall = {
    error: null,
    id: "call-legacy-skill",
    input: {
      path: "/skills/feynman/SKILL.md",
    },
    latencyMs: 29,
    output: {
      content: "name: feynman\nmust never render",
    },
    status: "completed" as const,
    tool: "read_file",
  };

  assert.equal(isRedactedSkillInstructionRead(toolCall), true);
  assert.equal(
    getAssistantToolTitle(toolCall),
    "Read Feynman skill instructions",
  );
  assert.equal(
    getSkillInstructionReadFileLabel(toolCall),
    "/skills/feynman/SKILL.md",
  );
});

test("tool cards prefer backend filesystem display titles", () => {
  const toolCall = {
    error: null,
    id: "call-work",
    input: {},
    latencyMs: 10,
    output: { content: "draft notes" },
    status: "completed" as const,
    tool: "read_file",
  };
  const toolStep = {
    id: "step-work",
    items: [],
    metadata: {
      filesystemScope: "work",
      toolCallId: "call-work",
      visibility: "normal",
    },
    status: "completed" as const,
    title: "Read Workfile",
  };

  assert.equal(getAssistantToolTitle(toolCall, toolStep), "Read Workfile");
});

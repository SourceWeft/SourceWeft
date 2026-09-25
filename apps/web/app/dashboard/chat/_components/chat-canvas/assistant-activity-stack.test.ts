import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import messages from "../../../../../messages/en.json";
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
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  TracePartRecord,
} from "./types";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardChatCanvas",
}) as unknown as ReturnType<typeof useTranslations>;

const testDisplayImageArtifactTool = defineAgentTool({
  id: "testDisplayImageArtifact",
  name: "test_display_image_artifact",
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
    displayName: "Test display image artifact",
  },
});

registerAgentTools([testDisplayImageArtifactTool]);

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
  assert.match(ASSISTANT_ACTIVITY_ICON_CLASS, /\bsize-5\b/);
  assert.match(ASSISTANT_ACTIVITY_ICON_CLASS, /\bjustify-start\b/);
  assert.match(ASSISTANT_ACTIVITY_LABEL_CLASS, /\bflex-1\b/);
  // Expanded detail hangs off a guide line under the icon, with its text on
  // the label's edge.
  for (const detail of [
    ASSISTANT_ACTIVITY_DETAIL_CLASS,
    ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS,
  ]) {
    assert.match(detail, /(^|\s)ml-\[10px\](\s|$)/);
    assert.match(detail, /\bborder-l\b/);
    assert.match(detail, /(^|\s)pl-\[17px\](\s|$)/);
  }
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
    getAssistantToolTitle(toolCall, t),
    "Load Feynman skill instructions",
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
    getAssistantToolTitle(toolCall, t),
    "Loading Frontend Design skill instructions",
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
    getAssistantToolTitle(toolCall, t),
    "Load Feynman skill instructions",
  );
  assert.equal(
    getSkillInstructionReadFileLabel(toolCall),
    "/skills/feynman/SKILL.md",
  );
});

test("tool cards use registry display names for image artifact tools", () => {
  assert.equal(
    getAssistantToolTitle(
      {
        error: null,
        id: "call-image",
        input: { prompt: "draw it" },
        latencyMs: 1200,
        output: null,
        status: "completed" as const,
        tool: "test_display_image_artifact",
      },
      t,
    ),
    "Test display image artifact",
  );
});

test("tool cards title workfile writes by basename", () => {
  assert.equal(
    getAssistantToolTitle(
      {
        error: null,
        id: "call-write-workfile",
        input: {
          content: "console.log('deck');",
          path: "/files/ppt/deck.js",
        },
        latencyMs: 1200,
        output: { path: "/files/ppt/deck.js" },
        status: "completed" as const,
        tool: "write_file",
      },
      t,
    ),
    "Wrote Workfile: deck.js",
  );
});

test("tool cards title workfile edits by basename", () => {
  assert.equal(
    getAssistantToolTitle(
      {
        error: null,
        id: "call-edit-workfile",
        input: {
          newString: "new",
          oldString: "old",
          path: "/files/ppt/deck.js",
        },
        latencyMs: 1200,
        output: { occurrences: 1, path: "/files/ppt/deck.js" },
        status: "completed" as const,
        tool: "edit_file",
      },
      t,
    ),
    "Edited Workfile: deck.js",
  );
});

test("tool cards keep default titles for non-workfile writes", () => {
  assert.equal(
    getAssistantToolTitle(
      {
        error: null,
        id: "call-write-other",
        input: {
          content: "console.log('deck');",
          path: "/tmp/deck.js",
        },
        latencyMs: 1200,
        output: { path: "/tmp/deck.js" },
        status: "completed" as const,
        tool: "write_file",
      },
      t,
    ),
    "Write File",
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

  assert.equal(getAssistantToolTitle(toolCall, t, toolStep), "Read Workfile");
});

describe("assistant-activity-items.test.ts", () => {
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
    assert.equal(
      item?.type === "tool" ? item.toolStep?.id : null,
      "search-step",
    );
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
    assert.equal(
      item?.type === "tool" ? item.toolCall.id : null,
      "image-tool-1",
    );
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
});

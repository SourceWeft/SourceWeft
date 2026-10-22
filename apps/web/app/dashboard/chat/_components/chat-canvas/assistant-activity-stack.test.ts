import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import messages from "../../../../../messages/en.json";
import { groupConsecutiveToolItems } from "./assistant-activity-groups";
import { buildAssistantActivityItems } from "./assistant-activity-items";
import { parseDelegateToolCall } from "./delegate-tool-card-state";
import { compactText, getToolOutputContent } from "./message-assets";
import { getReadFilePreview } from "./read-file-preview";
import { getSandboxExecuteView } from "./sandbox-tool-result-display";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
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

test("trace-only MCP activity retains explicit server and raw tool names", () => {
  const mcpDisplay = {
    serverName: "Microsoft Learn MCP",
    toolName: "microsoft_docs_fetch",
  };
  const [item] = buildAssistantActivityItems({
    traceParts: [
      {
        id: "fetch",
        kind: "tool",
        toolCallId: "fetch-call",
        tool: "mcp__com_microsoft_microsoft-learn-mc_371294fd__microso_69f82065",
        input: {},
        status: "completed",
        order: 1,
        createdAt: "2026-10-07T00:00:00Z",
        updatedAt: "2026-10-07T00:00:00Z",
        mcpDisplay,
      },
    ],
  });
  assert.deepEqual(
    item?.type === "tool" ? item.toolCall.mcpDisplay : undefined,
    mcpDisplay,
  );
});

describe("output-free trace parts resolve card output from the canonical tool call", () => {
  // Persisted trace parts carry structure only; `toolCalls[id].output` is the
  // single full copy (#330). Every card reader must see the same output it
  // would see on the canonical tool call.
  const createdAt = "2026-06-01T00:00:00.000Z";
  const stdout = "line\n".repeat(400);
  const report = `# Report\n${"x".repeat(600)}`;
  const readFileContent = Array.from(
    { length: 40 },
    (_, index) => `line ${index + 1}`,
  ).join("\n");
  const mcpDisplay = { serverName: "Docs", toolName: "Search docs" };
  const toolCalls: ToolCallRecord[] = [
    {
      id: "exec-1",
      tool: "execute",
      input: { command: "ls -R" },
      output: JSON.stringify({
        ok: true,
        output: stdout,
        truncated: true,
        exitCode: 0,
      }),
      latencyMs: 12,
      status: "completed",
      error: null,
      sequence: 1,
    },
    {
      id: "read-1",
      tool: "read_file",
      input: { path: "/files/notes.md" },
      output: { content: readFileContent },
      latencyMs: 3,
      status: "completed",
      error: null,
      sequence: 2,
    },
    {
      id: "task-1",
      tool: "task",
      input: { subagent_type: "explore", description: "Survey the repo." },
      output: { report, sourceweft: { childThreadId: "child-1" } },
      latencyMs: 900,
      status: "completed",
      error: null,
      sequence: 3,
    },
    {
      id: "search-1",
      tool: "search_docs",
      input: { query: "bounds" },
      output: { content: "y".repeat(500) },
      latencyMs: 5,
      status: "completed",
      error: null,
      sequence: 4,
      mcpDisplay,
    },
    {
      id: "confirm-1",
      tool: "execute",
      input: { command: "pwd" },
      output: {
        type: "tool_confirmation_request",
        schemaVersion: 1,
        id: "approval-1",
        domain: "connector",
        subject: { label: "Mac", provider: "provider", connectorId: "c-1" },
        action: {
          type: "execute",
          toolName: "execute",
          label: "Execute",
          riskLevel: "high",
          status: "proposed",
          requiresApproval: true,
        },
        preview: { title: "Run pwd" },
        decisionOptions: [
          { decision: "approve", label: "Approve" },
          { decision: "reject", label: "Reject" },
        ],
        execution: {
          providerStatus: "not_executed",
          executor: {
            kind: "connector_action_run",
            connectorId: "c-1",
            actionRunId: "r-1",
          },
        },
        status: "proposed",
        userMessage: "Waiting for confirmation.",
      },
      latencyMs: null,
      status: "approval_requested",
      error: null,
      sequence: 5,
    },
  ];
  // Neither output (#330) nor input (#333) is copied into the parts.
  const traceParts: TracePartRecord[] = toolCalls.map((toolCall, index) => ({
    createdAt,
    updatedAt: createdAt,
    id: `part-${toolCall.id}`,
    kind: "tool",
    order: index + 1,
    toolCallId: toolCall.id,
    tool: toolCall.tool,
    status: toolCall.status,
    error: toolCall.error,
    latencyMs: toolCall.latencyMs,
  }));
  const items = buildAssistantActivityItems({ toolCalls, traceParts });

  function resolved(id: string) {
    const item = items.find(
      (candidate) => candidate.type === "tool" && candidate.toolCall.id === id,
    );
    if (!item || item.type !== "tool") {
      throw new Error(`missing tool item ${id}`);
    }
    return item.toolCall;
  }
  function canonical(id: string) {
    const toolCall = toolCalls.find((candidate) => candidate.id === id);
    if (!toolCall) {
      throw new Error(`missing tool call ${id}`);
    }
    return toolCall;
  }

  test("every card sees the canonical output and input", () => {
    assert.equal(items.length, toolCalls.length);
    for (const toolCall of toolCalls) {
      assert.deepEqual(resolved(toolCall.id).output, toolCall.output);
      assert.deepEqual(resolved(toolCall.id).input, toolCall.input);
      assert.equal(resolved(toolCall.id).status, toolCall.status);
      assert.equal(resolved(toolCall.id).latencyMs, toolCall.latencyMs);
    }
  });

  test("generic card summary is unchanged", () => {
    const summary = (toolCall: ToolCallRecord) =>
      compactText(getToolOutputContent(toolCall.output) ?? "", 220);
    assert.equal(summary(resolved("search-1")), summary(canonical("search-1")));
    assert.ok(summary(resolved("search-1")).length > 0);
    assert.deepEqual(resolved("search-1").mcpDisplay, mcpDisplay);
  });

  test("read_file preview is unchanged", () => {
    const preview = getReadFilePreview(resolved("read-1"));
    assert.ok(preview);
    assert.deepEqual(preview, getReadFilePreview(canonical("read-1")));
    assert.equal(preview.isTruncated, true);
    assert.equal(preview.path, "/files/notes.md");
  });

  test("sandbox card keeps full stdout and the truncated flag", () => {
    const view = getSandboxExecuteView({
      input: resolved("exec-1").input,
      output: resolved("exec-1").output,
      toolName: "execute",
    });
    assert.ok(view);
    assert.equal(view.output, stdout);
    assert.equal(view.truncated, true);
    assert.deepEqual(
      view,
      getSandboxExecuteView({
        input: canonical("exec-1").input,
        output: canonical("exec-1").output,
        toolName: "execute",
      }),
    );
  });

  test("delegate card still extracts the report", () => {
    const view = parseDelegateToolCall(resolved("task-1"));
    assert.equal(view.report, report);
    assert.equal(view.childThreadId, "child-1");
    assert.equal(view.subagentType, "explore");
  });

  test("confirmation card still resolves the pending request", () => {
    const confirmation = getToolConfirmationOutput(
      resolved("confirm-1").output,
    );
    assert.ok(confirmation);
    assert.equal(confirmation.id, "approval-1");
    assert.equal(resolved("confirm-1").status, "approval_requested");
  });
});

describe("input-free trace parts resolve card input from the canonical tool call (#333)", () => {
  const createdAt = "2026-06-01T00:00:00.000Z";
  const part = (
    overrides: Partial<Extract<TracePartRecord, { kind: "tool" }>> = {},
  ): TracePartRecord => ({
    createdAt,
    updatedAt: createdAt,
    id: "part-tool-1",
    kind: "tool",
    order: 1,
    toolCallId: "tool-1",
    tool: "search_sources",
    status: "completed",
    ...overrides,
  });
  const toolCall: ToolCallRecord = {
    error: null,
    id: "tool-1",
    input: { query: "canonical" },
    latencyMs: 10,
    output: { resultCount: 1 },
    status: "completed",
    tool: "search_sources",
  };

  test("the canonical tool call's input wins over a legacy inline copy", () => {
    const [item] = buildAssistantActivityItems({
      toolCalls: [toolCall],
      traceParts: [part({ input: { query: "legacy" } })],
    });
    assert.deepEqual(item?.type === "tool" ? item.toolCall.input : null, {
      query: "canonical",
    });
  });

  test("an input-free part takes the canonical input", () => {
    const [item] = buildAssistantActivityItems({
      toolCalls: [toolCall],
      traceParts: [part()],
    });
    assert.deepEqual(item?.type === "tool" ? item.toolCall.input : null, {
      query: "canonical",
    });
  });

  test("a legacy part without a matching tool call keeps its inline input", () => {
    const [item] = buildAssistantActivityItems({
      traceParts: [part({ input: { query: "legacy" } })],
    });
    assert.deepEqual(item?.type === "tool" ? item.toolCall.input : null, {
      query: "legacy",
    });
  });

  test("an unmatched input-free part defaults to an empty input", () => {
    const [item] = buildAssistantActivityItems({ traceParts: [part()] });
    assert.deepEqual(item?.type === "tool" ? item.toolCall.input : null, {});
  });

  test("a structural reasoning part without text stays in the activity order", () => {
    const items = buildAssistantActivityItems({
      assistantText: "Final answer.",
      toolCalls: [toolCall],
      traceParts: [
        {
          createdAt,
          updatedAt: createdAt,
          durationMs: 1200,
          id: "reasoning-1",
          kind: "reasoning",
          order: 0,
          phase: "initial",
          text: "",
        },
        part(),
      ],
    });
    assert.deepEqual(
      items.map((item) => [item.type, item.id]),
      [
        ["reasoning", "reasoning-1"],
        ["tool", "part-tool-1"],
      ],
    );
    assert.equal(
      items[0]?.type === "reasoning" ? items[0].durationMs : null,
      1200,
    );
  });
});

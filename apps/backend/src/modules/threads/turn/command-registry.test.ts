import assert from "node:assert/strict";
import { test, vi } from "vitest";
import * as agentToolRegistry from "@sourceweft/agent-tool-registry";
import { findCapabilityToolCommandWorkflow } from "./capability-command-workflows";
import {
  renderSkillCommandWorkflow,
  renderToolCommandWorkflow,
} from "./command-registry";
import { resolveToolCommandName } from "./thread-command";

test("renderSkillCommandWorkflow renders manifest workflow metadata", () => {
  const workflow = renderSkillCommandWorkflow({
    arguments: "draw a dashboard",
    canonicalName: "/image-generate",
    displayName: "Image Generate",
    skillSlug: "image-generate",
    workflow: {
      execution: "agent",
      promptIntro: "Create an image artifact from the user's request.",
      defaultTools: ["generate_image"],
      permissionOverrides: { generate_image: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "image",
        toolName: "generate_image",
      },
      additionalPromptLines: [],
    },
  });

  assert.equal(workflow?.execution, "agent");
  assert.deepEqual(workflow?.defaultTools, ["generate_image"]);
  assert.deepEqual(workflow?.permissionOverrides, { generate_image: "allow" });
  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "image",
    toolName: "generate_image",
  });
  assert.match(
    workflow?.renderedPrompt ?? "",
    /Create an image artifact from the user's request/,
  );
});

test("renderToolCommandWorkflow keeps the artifact criterion the manifest declared", () => {
  vi.spyOn(agentToolRegistry, "getAgentToolSlashCommand").mockReturnValue({
    displayName: "Build mindmap",
    enabled: true,
    supportsCommand: true,
  });

  const workflow = renderToolCommandWorkflow({
    arguments: "map the quarterly report",
    canonicalName: "/mindmap",
    displayName: "Mindmap",
    toolName: "generate_mindmap",
    workflow: {
      execution: "agent",
      promptIntro: "Build a mindmap artifact.",
      defaultTools: ["generate_mindmap"],
      permissionOverrides: { generate_mindmap: "allow" },
      successCriteria: {
        kind: "artifact",
        // Not one of image | slides | video_presentation: the manifest declaration
        // is authoritative, so this must stay an artifact criterion.
        artifactType: "mindmap",
        toolName: "generate_mindmap",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "mindmap",
    toolName: "generate_mindmap",
  });
  assert.match(
    workflow?.renderedPrompt ?? "",
    /Success criteria: create a mindmap artifact using generate_mindmap\./,
  );
});

test("renderToolCommandWorkflow keeps a non-artifact criterion as tool_call", () => {
  vi.spyOn(agentToolRegistry, "getAgentToolSlashCommand").mockReturnValue({
    displayName: "Find Notion pages",
    enabled: true,
    supportsCommand: true,
  });

  const workflow = renderToolCommandWorkflow({
    arguments: "find quarterly report",
    canonicalName: "/notion-find",
    displayName: "Find Notion Pages",
    toolName: "search_notion_pages",
    workflow: {
      execution: "agent",
      promptIntro: "Search Notion pages.",
      defaultTools: ["search_notion_pages"],
      permissionOverrides: { search_notion_pages: "allow" },
      successCriteria: {
        kind: "tool_call",
        toolName: "search_notion_pages",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "tool_call",
    toolName: "search_notion_pages",
  });
});

test("renderSkillCommandWorkflow keeps a none criterion as none", () => {
  const workflow = renderSkillCommandWorkflow({
    arguments: "summarize the meeting",
    canonicalName: "/meeting-summary",
    displayName: "Meeting Summary",
    skillSlug: "meeting-summary",
    workflow: {
      execution: "agent",
      defaultTools: [],
      permissionOverrides: {},
      successCriteria: { kind: "none" },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, { kind: "none" });
});

test("renderSkillCommandWorkflow keeps slides artifact success criteria", () => {
  const workflow = renderSkillCommandWorkflow({
    arguments: "build a deck about Q3",
    canonicalName: "/ppt-deck",
    displayName: "PPT Deck",
    skillSlug: "ppt-deck",
    workflow: {
      execution: "agent",
      promptIntro: "Create a slides artifact.",
      defaultTools: ["publish_artifact"],
      permissionOverrides: { publish_artifact: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "slides",
        toolName: "publish_artifact",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "slides",
    toolName: "publish_artifact",
  });
});

test("renderSkillCommandWorkflow keeps a manifest-declared artifact success criterion", () => {
  const workflow = renderSkillCommandWorkflow({
    arguments: "create a training report",
    canonicalName: "/report",
    displayName: "Report Builder",
    skillSlug: "report-builder",
    workflow: {
      execution: "agent",
      promptIntro: "Create a report artifact.",
      defaultTools: ["publish_report"],
      permissionOverrides: { publish_report: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "custom_report",
        toolName: "publish_report",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "custom_report",
    toolName: "publish_report",
  });
});

test("/flashcards, /quiz and /mindmap are registered for real, not only as fixtures", async () => {
  // The fixtures above stub the registry; this reads the real one and the
  // study capability manifest's real workflows.
  vi.restoreAllMocks();
  for (const [alias, toolName] of [
    ["flashcards", "generate_flashcards"],
    ["quiz", "generate_quiz"],
    ["mindmap", "generate_mindmap"],
  ] as const) {
    const slash = agentToolRegistry.getAgentToolSlashCommand(toolName);
    assert.equal(slash?.supportsCommand, true);
    assert.deepEqual(slash?.aliases, [alias]);
    assert.equal(resolveToolCommandName(`/${alias}`), toolName);

    const workflow = renderToolCommandWorkflow({
      arguments: "about chapter 1",
      canonicalName: `/${toolName}`,
      displayName: slash!.displayName,
      toolName,
      workflow: await findCapabilityToolCommandWorkflow(toolName),
    });
    assert.ok(workflow, `/${alias} renders a workflow`);
    assert.deepEqual(workflow.defaultTools, [toolName]);
    assert.deepEqual(workflow.successCriteria, { kind: "none" });
    assert.ok(
      workflow.renderedPrompt.startsWith(
        `<sourceweft_command name="/${toolName}" kind="tool_workflow" tool="${toolName}">`,
      ),
    );
    assert.match(workflow.renderedPrompt, /about chapter 1/);
  }
});

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import * as agentToolRegistry from "@sourceweft/agent-tool-registry";
import {
  renderSkillCommandWorkflow,
  renderToolCommandWorkflow,
} from "./command-registry";

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

test("renderSkillCommandWorkflow keeps video presentation artifact success criteria", () => {
  const workflow = renderSkillCommandWorkflow({
    arguments: "create a training video",
    canonicalName: "/video",
    displayName: "Video Presentation",
    skillSlug: "video-presentation",
    workflow: {
      execution: "agent",
      promptIntro: "Create a video presentation artifact.",
      defaultTools: ["generate_video_presentation"],
      permissionOverrides: { generate_video_presentation: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "video_presentation",
        toolName: "generate_video_presentation",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "video_presentation",
    toolName: "generate_video_presentation",
  });
});

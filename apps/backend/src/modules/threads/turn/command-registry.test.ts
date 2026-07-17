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

test("renderToolCommandWorkflow falls back to tool_call for unknown artifact types", () => {
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
        kind: "artifact",
        artifactType: "unknown_artifact",
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

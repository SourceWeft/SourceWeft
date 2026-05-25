import assert from "node:assert/strict";
import { test } from "vitest";
import { ContentError } from "../../errors";
import {
  buildThreadToolsMetadata,
  resolveMcpToolSelection,
  resolveNotionToolSelections,
  resolveGenerateImageToolSelection,
  resolveWebSearchEnabled,
  testExports,
} from "./tool-selection";
import type { EnabledSkillDescriptor } from "../../skills/types";

function skill(input: Partial<EnabledSkillDescriptor>): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "skill-1",
    sourceType: "workspace_custom",
    name: "skill",
    version: "1.0.0",
    description: "Skill",
    files: [],
    ...input,
  };
}

test("resolveWebSearchEnabled reads tool-name keyed request before legacy flag", () => {
  assert.equal(
    resolveWebSearchEnabled({
      tools: {
        webSearchEnabled: true,
        web_search: { enabled: false },
      },
      enabledSkills: [skill({ name: "search", tools: ["web_search"] })],
    }),
    false,
  );
  assert.equal(
    resolveWebSearchEnabled({
      tools: undefined,
      enabledSkills: [skill({ name: "search", tools: ["web_search"] })],
    }),
    true,
  );
});

test("resolveGenerateImageToolSelection maps legacy artifact to generate_image config", () => {
  assert.deepEqual(
    resolveGenerateImageToolSelection({
      artifact: {
        kind: "image",
        mode: "generate",
        modelAlias: "legacy-image",
        image: { aspectRatio: "1:1", quality: "standard" },
      },
    }),
    {
      modelAlias: "legacy-image",
      config: { aspectRatio: "1:1", quality: "standard" },
    },
  );
});

test("buildThreadToolsMetadata stores canonical tool-name keyed fields", () => {
  assert.deepEqual(
    buildThreadToolsMetadata({
      skillIds: ["skill-1"],
      webSearchEnabled: true,
      generateImageTool: {
        config: { style: "cartoon" },
      },
      notionTools: {
        search_notion_pages: { enabled: true, connectorId: "connector_1" },
      },
    }),
    {
      skillIds: ["skill-1"],
      web_search: { enabled: true },
      generate_image: { config: { style: "cartoon" } },
      search_notion_pages: { enabled: true, connectorId: "connector_1" },
    },
  );
});

test("buildThreadToolsMetadata stores mcp install and tool selections", () => {
  const metadata = buildThreadToolsMetadata({
    skillIds: [],
    webSearchEnabled: false,
    mcpTools: {
      enabled: true,
      installIds: ["mcp_install_1"],
      toolIds: ["mcp_tool_1"],
    },
  });

  assert.deepEqual(metadata.mcp, {
    enabled: true,
    installIds: ["mcp_install_1"],
    toolIds: ["mcp_tool_1"],
  });
});

test("resolveMcpToolSelection keeps only concrete string ids", () => {
  assert.deepEqual(
    resolveMcpToolSelection({
      mcp: {
        enabled: true,
        installIds: ["mcp_install_1", "", 1],
        toolIds: ["mcp_tool_1", null],
      },
    } as unknown as Parameters<typeof resolveMcpToolSelection>[0]),
    {
      enabled: true,
      installIds: ["mcp_install_1"],
      toolIds: ["mcp_tool_1"],
    },
  );
});

test("resolveMcpToolSelectionFromToolsMetadata reads persisted mcp selection", () => {
  assert.deepEqual(
    testExports.resolveMcpToolSelectionFromToolsMetadata({
      mcp: {
        enabled: false,
        installIds: ["mcp_install_1"],
        toolIds: ["mcp_tool_1"],
      },
    }),
    {
      enabled: false,
      installIds: ["mcp_install_1"],
      toolIds: ["mcp_tool_1"],
    },
  );
});

test("resolveNotionToolSelections keeps notion connector tool selections only", () => {
  assert.deepEqual(
    resolveNotionToolSelections({
      search_notion_pages: { enabled: true, connectorId: "connector_1" },
      delete_notion_page: { enabled: true },
      create_notion_page: { enabled: false },
      web_search: { enabled: true },
    }),
    {
      search_notion_pages: { enabled: true, connectorId: "connector_1" },
      delete_notion_page: { enabled: true },
      create_notion_page: { enabled: false },
    },
  );
});

test("assertSelectedSkillsAllowedByTools rejects image skill when generate_image is disabled", () => {
  assert.throws(
    () =>
      testExports.assertSelectedSkillsAllowedByTools({
        generateImageTool: { enabled: false },
        enabledSkills: [
          skill({
            name: "image-skill",
            tools: ["generate_image"],
          }),
        ],
      }),
    (error) =>
      error instanceof ContentError && error.code === "SKILL_TOOL_DISABLED",
  );
});

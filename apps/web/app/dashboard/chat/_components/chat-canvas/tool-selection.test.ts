import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_TOOL_NAMES,
  registerAgentTools,
} from "@sourceweft/agent-tool-registry";
import {
  buildChatToolsRequest,
  buildCapabilityOptionToolsSelection,
  buildCapabilityToolToggleSelection,
  buildComposerToolsSelection,
  buildSkillOptionToolsSelection,
  isCapabilityToolVisibleInComposerOptions,
  resolveDefaultActiveSkillIds,
} from "./tool-selection";

const TEST_NOTION_TOOL = "test_notion_pages";

registerAgentTools([
  {
    id: "testNotionPages",
    name: TEST_NOTION_TOOL,
    domain: "connector",
    capabilities: ["connector", "notion", "connector_read"],
    activation: {
      default: "off",
      userControl: "enable-disable",
      skill: {
        declarable: true,
        activates: true,
      },
    },
    defaultPermission: "allow",
    riskLevel: "low",
  },
]);

test("buildChatToolsRequest preserves dynamic tool selections and invoked skills", () => {
  const tools = buildChatToolsRequest({
    invokedSkillIds: ["skill-invoked"],
    skillIds: ["skill-selected"],
    tools: {
      generate_image: {
        enabled: true,
        config: {
          aspectRatio: "16:9",
          style: "cartoon",
        },
      },
      mcp: {
        enabled: true,
        installIds: ["mcp-1"],
        toolIds: ["tool-1"],
      },
    },
  });

  assert.deepEqual(tools, {
    skillIds: ["skill-selected"],
    invokedSkillIds: ["skill-invoked"],
    generate_image: {
      enabled: true,
      config: {
        aspectRatio: "16:9",
        style: "cartoon",
      },
    },
    mcp: {
      enabled: true,
      installIds: ["mcp-1"],
      toolIds: ["tool-1"],
    },
  });
});

test("buildChatToolsRequest caps skillIds to the contract maximum", () => {
  const tools = buildChatToolsRequest({
    skillIds: [
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "skill-6",
      "skill-1",
    ],
    invokedSkillIds: [
      "invoked-1",
      "invoked-2",
      "invoked-3",
      "invoked-4",
      "invoked-5",
      "invoked-6",
    ],
  });

  assert.deepEqual(tools.skillIds, [
    "skill-1",
    "skill-2",
    "skill-3",
    "skill-4",
    "skill-5",
  ]);
  assert.deepEqual(tools.invokedSkillIds, [
    "invoked-1",
    "invoked-2",
    "invoked-3",
    "invoked-4",
    "invoked-5",
  ]);
});

test("buildChatToolsRequest serializes web access as search and fetch selections", () => {
  assert.deepEqual(
    buildChatToolsRequest({
      searchEnabled: false,
      skillIds: [],
    }),
    {
      skillIds: [],
      [AGENT_TOOL_NAMES.webSearch]: { enabled: false },
      [AGENT_TOOL_NAMES.webFetch]: { enabled: false },
    },
  );

  assert.deepEqual(
    buildChatToolsRequest({
      searchEnabled: true,
      tools: {
        [AGENT_TOOL_NAMES.webSearch]: { enabled: false },
      },
    }),
    {
      skillIds: [],
      [AGENT_TOOL_NAMES.webSearch]: { enabled: true },
      [AGENT_TOOL_NAMES.webFetch]: { enabled: true },
    },
  );
});

test("composer options hide internal image, web, retrieval, and sandbox tools", () => {
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.generateImage,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.publishArtifact,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.webSearch,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.webFetch,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.searchSources,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({
      toolName: AGENT_TOOL_NAMES.execute,
    }),
    false,
  );
  assert.equal(
    isCapabilityToolVisibleInComposerOptions({ toolName: "custom_tool" }),
    true,
  );
});

test("buildComposerToolsSelection maps connector tool enabled state", () => {
  const tools = buildComposerToolsSelection({
    activeConnectorIds: { notion: "connector-1" },
    connectorToolsEnabled: { notion: false },
    disabledToolNames: [],
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[TEST_NOTION_TOOL], {
    connectorId: "connector-1",
    enabled: false,
  });
});

test("buildComposerToolsSelection omits tools when no connector state is configured", () => {
  const tools = buildComposerToolsSelection({
    disabledToolNames: [],
    selectedSkills: [],
  });

  assert.equal(tools, undefined);
});

test("buildSkillOptionToolsSelection maps selected skill option overrides to tool config", () => {
  const tools = buildSkillOptionToolsSelection({
    selectedSkills: [
      {
        id: "skill-1",
        catalogId: "skill:1",
        slug: "visual-story",
        name: "visual-story",
        displayName: "Visual Story",
        description: "Create visual stories.",
        sourceType: "builtin",
        version: "1.0.0",
        hasReadme: false,
        tools: [AGENT_TOOL_NAMES.generateImage],
        options: [
          {
            id: "style",
            title: "Style",
            valueType: "string",
            defaultValue: "auto",
            target: {
              toolName: AGENT_TOOL_NAMES.generateImage,
              path: "config.style",
            },
            values: [
              { value: "auto", label: "Auto" },
              { value: "cartoon", label: "Cartoon" },
            ],
          },
          {
            id: "quality",
            title: "Quality",
            valueType: "string",
            defaultValue: "auto",
            target: {
              toolName: AGENT_TOOL_NAMES.generateImage,
              path: "config.quality",
            },
            values: [
              { value: "auto", label: "Auto" },
              { value: "high", label: "High" },
            ],
          },
        ],
      },
    ],
    overrides: {
      "skill-1": {
        quality: "high",
        style: "cartoon",
      },
    },
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateImage], {
    enabled: true,
    config: {
      quality: "high",
      style: "cartoon",
    },
  });
});

test("resolveDefaultActiveSkillIds keeps default-enabled skills active", () => {
  assert.deepEqual(
    resolveDefaultActiveSkillIds({
      availableSkills: [
        { id: "builtin:image-generate", defaultEnabled: true },
        { id: "builtin:ppt-deck", defaultEnabled: true },
        { id: "builtin:video-presentation", defaultEnabled: true },
        { id: "manual-skill", defaultEnabled: false },
      ],
      currentSkillIds: ["missing-skill", "manual-skill"],
    }),
    [
      "builtin:image-generate",
      "builtin:ppt-deck",
      "builtin:video-presentation",
      "manual-skill",
    ],
  );
});

test("resolveDefaultActiveSkillIds does not truncate default-enabled skills", () => {
  assert.deepEqual(
    resolveDefaultActiveSkillIds({
      availableSkills: [
        { id: "builtin:image-generate", defaultEnabled: true },
        { id: "builtin:ppt-deck", defaultEnabled: true },
        { id: "builtin:video-presentation", defaultEnabled: true },
        { id: "builtin:default-4", defaultEnabled: true },
        { id: "builtin:default-5", defaultEnabled: true },
        { id: "builtin:default-6", defaultEnabled: true },
        { id: "manual-skill", defaultEnabled: false },
      ],
      currentSkillIds: ["manual-skill"],
      maxSkills: 5,
    }),
    [
      "builtin:image-generate",
      "builtin:ppt-deck",
      "builtin:video-presentation",
      "builtin:default-4",
      "builtin:default-5",
      "builtin:default-6",
    ],
  );
});

test("buildSkillOptionToolsSelection maps runtime skill options to skill config", () => {
  const tools = buildSkillOptionToolsSelection({
    selectedSkills: [
      {
        id: "ppt-skill",
        catalogId: "skill:ppt",
        slug: "ppt-deck",
        name: "ppt-deck",
        displayName: "PPT Deck",
        description: "Create decks.",
        sourceType: "builtin",
        version: "1.0.0",
        hasReadme: false,
        defaultEnabled: true,
        options: [
          {
            id: "stylePreset",
            title: "Style",
            valueType: "string",
            defaultValue: "auto",
            target: {
              path: "config.stylePreset",
            },
            values: [
              { value: "auto", label: "Auto" },
              { value: "executive", label: "Executive" },
            ],
          },
        ],
      },
    ],
    overrides: {
      "ppt-skill": {
        stylePreset: "executive",
      },
    },
  });

  assert.deepEqual(tools?.skillRuntimeConfig, {
    "ppt-skill": {
      stylePreset: "executive",
    },
  });
});

test("buildCapabilityOptionToolsSelection maps tool option overrides to tool selection", () => {
  const tools = buildCapabilityOptionToolsSelection({
    catalogTools: [
      {
        id: "tool-generate-image",
        capabilityId: "capability-generate-image",
        contributionId: "contribution-generate-image",
        toolName: AGENT_TOOL_NAMES.generateImage,
        title: "Generate image",
        description: "Generate an image.",
        inputSchema: {},
        outputSchema: {},
        risk: "write",
        sourcePackageName: null,
        options: [
          {
            id: "aspectRatio",
            title: "Aspect ratio",
            valueType: "string",
            defaultValue: "auto",
            target: {
              path: "config.aspectRatio",
            },
            values: [
              { value: "auto", label: "Auto" },
              { value: "16:9", label: "16:9" },
            ],
          },
          {
            id: "quality",
            title: "Quality",
            valueType: "string",
            defaultValue: "auto",
            target: {
              path: "config.quality",
            },
            values: [
              { value: "auto", label: "Auto" },
              { value: "higher", label: "Higher" },
            ],
          },
        ],
      },
    ],
    overrides: {
      [AGENT_TOOL_NAMES.generateImage]: {
        aspectRatio: "16:9",
        quality: "higher",
      },
    },
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateImage], {
    enabled: true,
    config: {
      aspectRatio: "16:9",
      quality: "higher",
    },
  });
});

test("buildCapabilityToolToggleSelection maps tool enabled overrides", () => {
  const tools = buildCapabilityToolToggleSelection({
    catalogTools: [
      {
        id: "tool-generate-image",
        capabilityId: "capability-generate-image",
        contributionId: "contribution-generate-image",
        toolName: AGENT_TOOL_NAMES.generateImage,
        title: "Generate image",
        description: "Generate an image.",
        inputSchema: {},
        outputSchema: {},
        risk: "write",
        sourcePackageName: null,
        options: [],
      },
    ],
    overrides: {
      [AGENT_TOOL_NAMES.generateImage]: false,
    },
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateImage], {
    enabled: false,
  });
});

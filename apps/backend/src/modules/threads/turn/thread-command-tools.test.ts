import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  applyCapabilityToolOptionDefaults,
  mergeActiveSkillRuntimeTools,
  mergeCommandTools,
  mergeInvocationTools,
  resolveToolPermissions,
} from "./thread-command-tools";
import type { ResolvedThreadCommand, ResolvedThreadInvocation } from "./types";
import type { CapabilityToolListItem } from "@sourceweft/capability-runtime";

function pptSkillCommand(): ResolvedThreadCommand {
  return {
    name: "/ppt",
    canonicalName: "/ppt-deck",
    arguments: "make it",
    kind: "skill",
    displayName: "PPT Deck",
    description: "Create a PPT deck",
    workflow: {
      name: "/ppt-deck",
      arguments: "make it",
      kind: "skill_workflow",
      renderedPrompt: "prompt",
      defaultTools: [
        AGENT_TOOL_NAMES.prepareSandboxWorkspace,
        AGENT_TOOL_NAMES.execute,
        AGENT_TOOL_NAMES.publishSandboxArtifact,
      ],
      permissionOverrides: {},
      successCriteria: {
        kind: "artifact",
        artifactType: "slides",
        toolName: AGENT_TOOL_NAMES.publishSandboxArtifact,
      },
      execution: "agent",
    },
  };
}

test("mergeCommandTools enables ppt skill sandbox tools and publisher tool", () => {
  const tools = mergeCommandTools(undefined, pptSkillCommand());

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.prepareSandboxWorkspace], {
    enabled: true,
  });
  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.execute], {
    enabled: true,
  });
  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.publishSandboxArtifact], {
    enabled: true,
  });
  const permissions = resolveToolPermissions({ command: null, tools });
  assert.equal(permissions[AGENT_TOOL_NAMES.generateImage], "allow");
  assert.equal(permissions[AGENT_TOOL_NAMES.publishSandboxArtifact], "ask");
});

test("mergeActiveSkillRuntimeTools enables skill tools without command and respects disabled tools", () => {
  const runtime = {
    defaultTools: [
      AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      AGENT_TOOL_NAMES.execute,
      AGENT_TOOL_NAMES.publishSandboxArtifact,
    ],
    permissionOverrides: {},
  } as const;

  assert.deepEqual(mergeActiveSkillRuntimeTools(undefined, runtime), {
    [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: { enabled: true },
    [AGENT_TOOL_NAMES.execute]: { enabled: true },
    [AGENT_TOOL_NAMES.publishSandboxArtifact]: { enabled: true },
  });

  assert.deepEqual(
    mergeActiveSkillRuntimeTools(
      {
        [AGENT_TOOL_NAMES.publishSandboxArtifact]: { enabled: false },
      },
      runtime,
    ),
    {
      [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: { enabled: true },
      [AGENT_TOOL_NAMES.execute]: { enabled: true },
      [AGENT_TOOL_NAMES.publishSandboxArtifact]: { enabled: false },
    },
  );
});

test("resolveToolPermissions keeps publisher denied when disabled outside ppt workflow", () => {
  const command = pptSkillCommand();
  const enabledTools = mergeCommandTools(undefined, command);

  assert.deepEqual(enabledTools?.[AGENT_TOOL_NAMES.publishSandboxArtifact], {
    enabled: true,
  });

  const disabledTools = {
    [AGENT_TOOL_NAMES.publishSandboxArtifact]: { enabled: false },
  };
  assert.equal(
    resolveToolPermissions({ command, tools: disabledTools })[
      AGENT_TOOL_NAMES.publishSandboxArtifact
    ],
    "deny",
  );
});

test("resolveToolPermissions treats web search and fetch as one web access selection", () => {
  const disabledFromSearch = resolveToolPermissions({
    command: null,
    tools: {
      [AGENT_TOOL_NAMES.webSearch]: { enabled: false },
      [AGENT_TOOL_NAMES.webFetch]: { enabled: true },
    },
  });

  assert.equal(disabledFromSearch[AGENT_TOOL_NAMES.webSearch], "deny");
  assert.equal(disabledFromSearch[AGENT_TOOL_NAMES.webFetch], "deny");

  const disabledFromFetch = resolveToolPermissions({
    command: null,
    tools: {
      [AGENT_TOOL_NAMES.webFetch]: { enabled: false },
    },
  });

  assert.equal(disabledFromFetch[AGENT_TOOL_NAMES.webSearch], "deny");
  assert.equal(disabledFromFetch[AGENT_TOOL_NAMES.webFetch], "deny");
});

test("mergeInvocationTools enables fixed capability tool choices", () => {
  const invocation = {
    kind: "fixed_tool_choice",
    selectableId: "cap:sourceweft/generate-image:generate_image",
    target: "capability_tool",
    toolName: AGENT_TOOL_NAMES.generateImage,
    sourceRef: {
      kind: "capability_tool",
      capabilityId: "sourceweft/generate-image",
      contributionId: "generate_image",
      legacyToolName: AGENT_TOOL_NAMES.generateImage,
      sourcePackageName: null,
      toolName: AGENT_TOOL_NAMES.generateImage,
    },
    userInput: "draw it",
    events: [],
  } satisfies ResolvedThreadInvocation;

  assert.deepEqual(mergeInvocationTools(undefined, invocation), {
    [AGENT_TOOL_NAMES.generateImage]: { enabled: true },
  });

  assert.deepEqual(
    mergeInvocationTools(
      { [AGENT_TOOL_NAMES.generateImage]: { enabled: false } },
      invocation,
    ),
    { [AGENT_TOOL_NAMES.generateImage]: { enabled: false } },
  );
});

test("applyCapabilityToolOptionDefaults fills missing manifest option values", () => {
  const catalogTool = {
    id: "cap:sourceweft/generate-image:generate_image",
    capabilityId: "sourceweft/generate-image",
    contributionId: "generate_image",
    description: "Generate image",
    inputSchema: {},
    options: [
      {
        id: "aspectRatio",
        title: "Aspect ratio",
        valueType: "string",
        defaultValue: "auto",
        target: { path: "config.aspectRatio" },
        values: [],
      },
      {
        id: "style",
        title: "Style",
        valueType: "string",
        defaultValue: "auto",
        target: { path: "config.style" },
        values: [],
      },
    ],
    order: 0,
    outputSchema: {},
    risk: "write",
    sourcePackageName: "@sourceweft/builtin-tool-generate-image",
    title: "Generate Image",
    toolName: AGENT_TOOL_NAMES.generateImage,
  } satisfies CapabilityToolListItem;

  const tools = applyCapabilityToolOptionDefaults(
    {
      [AGENT_TOOL_NAMES.generateImage]: {
        enabled: true,
        config: {
          style: "cartoon",
        },
      },
    },
    [catalogTool],
  );

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateImage], {
    enabled: true,
    config: {
      aspectRatio: "auto",
      style: "cartoon",
    },
  });
});

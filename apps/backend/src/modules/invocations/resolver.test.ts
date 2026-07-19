import assert from "node:assert/strict";
import { test } from "vitest";
import { createSelectableInvocationRegistry } from "./registry";
import { resolveInvocationSelection } from "./resolver";
import type { SelectableInvocationDefinition } from "./types";

function provider(definitions: SelectableInvocationDefinition[]) {
  return { id: "fake", list: () => definitions };
}

const capabilityToolDefinition: SelectableInvocationDefinition = {
  id: "cap:sourceweft/generate-image:generate_image",
  label: "Generate image",
  enabled: true,
  sourceRef: {
    kind: "capability_tool",
    capabilityId: "sourceweft/generate-image",
    contributionId: "generate_image",
    sourcePackageName: null,
      toolName: "generate_image",
  },
  semantics: {
    kind: "fixed_tool_choice",
    target: "capability_tool",
    toolName: "generate_image",
  },
};

const skillDefinition: SelectableInvocationDefinition = {
  id: "skill_command.research.summarize",
  label: "Summarize",
  enabled: true,
  sourceRef: {
    kind: "skill_command",
    skillSlug: "research",
    commandName: "summarize",
  },
  semantics: {
    kind: "context_injection",
    workflow: "Follow the research workflow.",
  },
};

const mcpToolDefinition: SelectableInvocationDefinition = {
  id: "mcp_tool.mcp_install_1.github_create_issue",
  label: "Create issue",
  enabled: true,
  sourceRef: {
    kind: "mcp_tool",
    serverInstallId: "mcp_install_1",
    serverToolName: "create_issue",
    normalizedToolName: "github_create_issue",
  },
  semantics: {
    kind: "fixed_tool_choice",
    target: "mcp_tool",
    toolName: "mcp__mcp_install_1__github_create_issue",
  },
};

const mcpPromptDefinition: SelectableInvocationDefinition = {
  id: "mcp_prompt.mcp_install_1.triage_issue",
  label: "Triage issue",
  enabled: true,
  sourceRef: {
    kind: "mcp_prompt",
    serverInstallId: "mcp_install_1",
    promptName: "triage_issue",
  },
  semantics: { kind: "mcp_prompt", promptName: "triage_issue" },
};

const mcpResourceDefinition: SelectableInvocationDefinition = {
  id: "mcp_resource.mcp_install_1.resource_1",
  label: "Issue 1",
  enabled: true,
  sourceRef: {
    kind: "mcp_resource",
    serverInstallId: "mcp_install_1",
    uri: "github://issues/1",
  },
  semantics: { kind: "mcp_resource", uri: "github://issues/1" },
};

const directExecuteDefinition: SelectableInvocationDefinition = {
  id: "mcp_tool.mcp_install_1.direct_create_issue",
  label: "Create issue directly",
  enabled: true,
  sourceRef: mcpToolDefinition.sourceRef,
  semantics: {
    kind: "direct_execute",
    inputSchema: {},
    requiresCompleteStructuredArgs: true,
  },
};

test("resolver resolves capability tool selection to bind tool choice", () => {
  const registry = createSelectableInvocationRegistry({ providers: [provider([capabilityToolDefinition])] });
  const result = resolveInvocationSelection({
    registry,
    envelope: { selectableId: capabilityToolDefinition.id, userInput: "make an image" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.kind : null, "bind_tool_choice");
  assert.equal(result.ok ? result.plan.sourceRef.kind : null, "capability_tool");
});

test("resolver resolves skill command to context injection only", () => {
  const registry = createSelectableInvocationRegistry({ providers: [provider([skillDefinition])] });
  const result = resolveInvocationSelection({
    registry,
    envelope: { selectableId: skillDefinition.id, userInput: "summarize" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.kind : null, "inject_context");
});

test("resolver resolves MCP tool without structured args to bind tool choice", () => {
  const registry = createSelectableInvocationRegistry({ providers: [provider([mcpToolDefinition])] });
  const result = resolveInvocationSelection({
    registry,
    envelope: { selectableId: mcpToolDefinition.id, userInput: "create an issue" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.kind : null, "bind_tool_choice");
  assert.equal(result.ok ? result.plan.sourceRef.kind : null, "mcp_tool");
});

test("resolver resolves MCP tool with complete structured args to direct execute when eligible", () => {
  const registry = createSelectableInvocationRegistry({ providers: [provider([mcpToolDefinition])] });
  const result = resolveInvocationSelection({
    registry,
    envelope: {
      selectableId: mcpToolDefinition.id,
      userInput: "create an issue",
      structuredArgs: { title: "Bug" },
    },
    directExecuteEligible: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.kind : null, "direct_execute");
});

test("resolver quarantines direct execute definitions unless explicitly eligible", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [provider([directExecuteDefinition])],
  });
  const blocked = resolveInvocationSelection({
    registry,
    envelope: {
      selectableId: directExecuteDefinition.id,
      userInput: "create an issue",
      structuredArgs: { title: "Bug" },
    },
  });
  const allowed = resolveInvocationSelection({
    registry,
    envelope: {
      selectableId: directExecuteDefinition.id,
      userInput: "create an issue",
      structuredArgs: { title: "Bug" },
    },
    directExecuteEligible: true,
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? null : blocked.error.code, "INVOCATION_UNAVAILABLE");
  assert.equal(blocked.ok ? null : blocked.error.sourceRef?.kind, "mcp_tool");
  assert.equal(blocked.ok ? null : blocked.error.recoverable, false);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ok ? allowed.plan.kind : null, "direct_execute");
});

test("resolver resolves MCP prompt and resource to typed planned states", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [provider([mcpPromptDefinition, mcpResourceDefinition])],
  });
  const prompt = resolveInvocationSelection({
    registry,
    envelope: { selectableId: mcpPromptDefinition.id, userInput: "triage" },
  });
  const resource = resolveInvocationSelection({
    registry,
    envelope: { selectableId: mcpResourceDefinition.id, userInput: "read" },
  });

  assert.equal(prompt.ok ? prompt.plan.kind : null, "mcp_prompt");
  assert.equal(resource.ok ? resource.plan.kind : null, "mcp_resource");
});

test("resolver returns normalized error for unavailable or missing explicit selection", () => {
  const unavailable = { ...capabilityToolDefinition, enabled: false, unavailableReason: "Disabled" };
  const registry = createSelectableInvocationRegistry({ providers: [provider([unavailable])] });
  const disabledResult = resolveInvocationSelection({
    registry,
    envelope: { selectableId: unavailable.id, userInput: "make an image" },
  });
  const missingResult = resolveInvocationSelection({
    registry,
    envelope: { selectableId: "missing", userInput: "make an image" },
  });

  assert.equal(disabledResult.ok, false);
  assert.equal(disabledResult.ok ? null : disabledResult.error.code, "INVOCATION_UNAVAILABLE");
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.ok ? null : missingResult.error.code, "INVOCATION_NOT_FOUND");
});

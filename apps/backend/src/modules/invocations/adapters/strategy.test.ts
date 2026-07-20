import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createLangChainMcpClient } from "../../mcp/langchain-client";
import { createDeepAgentsRuntimeHandoff } from "../deepagents-runtime";
import {
  createCapabilityToolChoiceAdapter,
  createMcpToolChoiceAdapter,
  createSkillContextAdapter,
} from "./strategy";
import type { InvocationPlan } from "../types";

vi.mock("../../mcp/langchain-client", () => ({
  createLangChainMcpClient: vi.fn(() => ({
    getTools: vi.fn(async () => [{ name: "mcp__mcp_install_1__github_create_issue" }]),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("../deepagents-runtime", () => ({
  createDeepAgentsRuntimeHandoff: vi.fn((input) => ({
    boundary: "deepagents",
    runtime: { invoke: vi.fn() },
    tools: input.tools,
  })),
}));

function capabilityToolPlan(): Extract<InvocationPlan, { kind: "bind_tool_choice" }> {
  return {
    kind: "bind_tool_choice",
    selectableId: "cap:sourceweft/generate-image:generate_image",
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
    userInput: "make image",
  };
}

function mcpPlan(): Extract<InvocationPlan, { kind: "bind_tool_choice" }> {
  return {
    kind: "bind_tool_choice",
    selectableId: "mcp_tool.mcp_install_1.github_create_issue",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
    },
    semantics: {
      kind: "fixed_tool_choice",
      target: "mcp_tool",
      toolName: "mcp__mcp_install_1__github_create_issue",
    },
    userInput: "create issue",
  };
}

test("capability adapter produces DeepAgents handoff payload with fixed tool choice", async () => {
  vi.mocked(createDeepAgentsRuntimeHandoff).mockClear();
  const adapter = createCapabilityToolChoiceAdapter({
    tools: [{ name: "generate_image", description: "Generate image" }],
    model: "test-model",
  });
  const output = await adapter.prepare(capabilityToolPlan());

  assert.equal(output.kind, "deepagents_handoff");
  assert.equal(output.sourceRef.kind, "capability_tool");
  assert.equal(output.toolChoice, "generate_image");
  assert.equal(vi.mocked(createDeepAgentsRuntimeHandoff).mock.calls.length, 1);
});

test("MCP adapter uses mandated LangChain MCP client path and preserves source identity", async () => {
  vi.mocked(createLangChainMcpClient).mockClear();
  const adapter = createMcpToolChoiceAdapter({
    install: {
      id: "mcp_install_1",
      transport: "streamable_http",
      endpointUrl: "https://mcp.example.com/mcp",
    },
    headers: { Authorization: "Bearer secret" },
    model: "test-model",
  });
  const output = await adapter.prepare(mcpPlan());

  assert.equal(output.kind, "deepagents_handoff");
  assert.equal(output.sourceRef.kind, "mcp_tool");
  assert.equal(output.sourceRef.kind === "mcp_tool" ? output.sourceRef.serverInstallId : null, "mcp_install_1");
  assert.equal(vi.mocked(createLangChainMcpClient).mock.calls.length, 1);
});

test("skill adapter returns context instruction payload only", () => {
  const adapter = createSkillContextAdapter();
  const output = adapter.prepare({
    kind: "inject_context",
    selectableId: "skill_command.research.summarize",
    sourceRef: {
      kind: "skill_command",
      skillSlug: "research",
      commandName: "summarize",
    },
    semantics: { kind: "context_injection", workflow: "Summarize sources." },
    userInput: "summarize",
  });

  assert.deepEqual(output, {
    kind: "context_payload",
    selectableId: "skill_command.research.summarize",
    instruction: "Summarize sources.",
  });
});

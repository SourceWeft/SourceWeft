import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createInvocationEvent,
  INVOCATION_EVENT_TYPES,
} from "./events";
import {
  createNormalizedInvocationError,
  INVOCATION_ERROR_CODES,
} from "./errors";
import {
  INVOCATION_SOURCE_KINDS,
  type InvocationEnvelope,
  type InvocationEvent,
  type InvocationPlan,
  type InvocationSemantics,
  type InvocationSourceRef,
  type NormalizedInvocationError,
  type SelectableInvocationDefinition,
} from "./types";

test("invocation source refs distinguish capability, skill, and MCP capabilities", () => {
  assert.deepEqual(INVOCATION_SOURCE_KINDS, [
    "capability_tool",
    "skill_command",
    "mcp_tool",
    "mcp_prompt",
    "mcp_resource",
  ]);

  const refs: InvocationSourceRef[] = [
    {
      kind: "capability_tool",
      capabilityId: "sourceweft/generate-image",
      contributionId: "generate_image",
      sourcePackageName: null,
      toolName: "generate_image",
    },
    {
      kind: "skill_command",
      skillSlug: "research",
      commandName: "summarize",
    },
    {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
      normalizedToolName: "github_create_issue",
      toolId: "tool_1",
    },
    {
      kind: "mcp_prompt",
      serverInstallId: "mcp_install_1",
      promptName: "triage_issue",
    },
    {
      kind: "mcp_resource",
      serverInstallId: "mcp_install_1",
      uri: "github://issues/1",
    },
  ];

  assert.deepEqual(
    refs.map((ref) => ref.kind),
    INVOCATION_SOURCE_KINDS,
  );
  assert.equal(refs[2]?.kind === "mcp_tool" ? refs[2].serverInstallId : null, "mcp_install_1");
});

test("selectable definitions model supported invocation semantics without execution", () => {
  const semantics: InvocationSemantics[] = [
    {
      kind: "fixed_tool_choice",
      target: "capability_tool",
      toolName: "generate_image",
    },
    {
      kind: "fixed_tool_choice",
      target: "mcp_tool",
      toolName: "mcp__github__create_issue",
    },
    {
      kind: "context_injection",
      workflow: "Use the skill workflow before answering.",
    },
    {
      kind: "direct_execute",
      requiresCompleteStructuredArgs: true,
      inputSchema: { type: "object" },
    },
    { kind: "mcp_prompt", promptName: "triage_issue" },
    { kind: "mcp_resource", uri: "github://issues/1" },
  ];

  const definition: SelectableInvocationDefinition = {
    id: "cap:sourceweft/generate-image:generate_image",
    label: "Generate image",
    description: "Create an image artifact",
    sourceRef: {
      kind: "capability_tool",
      capabilityId: "sourceweft/generate-image",
      contributionId: "generate_image",
      sourcePackageName: null,
      toolName: "generate_image",
    },
    semantics: semantics[0] ?? {
      kind: "fixed_tool_choice",
      target: "capability_tool",
      toolName: "generate_image",
    },
    enabled: true,
  };

  assert.equal(definition.semantics.kind, "fixed_tool_choice");
  assert.deepEqual(
    semantics.map((item) => item.kind),
    [
      "fixed_tool_choice",
      "fixed_tool_choice",
      "context_injection",
      "direct_execute",
      "mcp_prompt",
      "mcp_resource",
    ],
  );
});

test("envelopes and plans preserve selectable id, input, structured args, and source identity", () => {
  const sourceRef: InvocationSourceRef = {
    kind: "mcp_tool",
    serverInstallId: "mcp_install_1",
    serverToolName: "create_issue",
  };
  const envelope: InvocationEnvelope = {
    selectableId: "mcp.mcp_install_1.tool.create_issue",
    userInput: "Create an issue for the failing test",
    structuredArgs: { title: "Failing test" },
  };
  const plan: InvocationPlan = {
    kind: "direct_execute",
    selectableId: envelope.selectableId,
    sourceRef,
    semantics: {
      kind: "direct_execute",
      requiresCompleteStructuredArgs: true,
      inputSchema: { type: "object" },
    },
    structuredArgs: envelope.structuredArgs,
  };

  assert.equal(plan.kind, "direct_execute");
  assert.equal(plan.sourceRef.kind, "mcp_tool");
  assert.equal(
    plan.sourceRef.kind === "mcp_tool" ? plan.sourceRef.serverInstallId : null,
    "mcp_install_1",
  );
});

test("normalized invocation errors expose required error codes and source identity", () => {
  assert.ok(INVOCATION_ERROR_CODES.includes("MCP_TRANSPORT_UNSUPPORTED"));
  assert.ok(INVOCATION_ERROR_CODES.includes("MCP_MANIFEST_STALE"));
  assert.ok(INVOCATION_ERROR_CODES.includes("SKILL_NOT_ENABLED"));
  assert.ok(INVOCATION_ERROR_CODES.includes("SCHEMA_MISMATCH"));
  assert.ok(INVOCATION_ERROR_CODES.includes("RUNTIME_HANDOFF_UNAVAILABLE"));

  const error: NormalizedInvocationError = createNormalizedInvocationError({
    code: "MCP_MANIFEST_STALE",
    message: "Manifest snapshot is stale",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
    },
    recoverable: false,
  });

  assert.equal(error.code, "MCP_MANIFEST_STALE");
  assert.equal(error.sourceRef?.kind, "mcp_tool");
});

test("invocation events cover resolution, policy, approval, handoff, result, and error states", () => {
  assert.deepEqual(INVOCATION_EVENT_TYPES, [
    "resolve",
    "policy",
    "approval_required",
    "tool_choice_bound",
    "context_injected",
    "direct_execute",
    "deepagents_handoff",
    "result",
    "error",
  ]);

  const sourceRef: InvocationSourceRef = {
    kind: "capability_tool",
    capabilityId: "sourceweft/generate-image",
    contributionId: "generate_image",
    sourcePackageName: null,
    toolName: "generate_image",
  };
  const events: InvocationEvent[] = [
    createInvocationEvent({ type: "resolve", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef }),
    createInvocationEvent({ type: "policy", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, decision: "allow" }),
    createInvocationEvent({ type: "approval_required", selectableId: "mcp.tool", sourceRef, approvalRef: "approval_1", reason: "High risk MCP tool" }),
    createInvocationEvent({ type: "tool_choice_bound", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, toolName: "generate_image" }),
    createInvocationEvent({ type: "context_injected", selectableId: "skill.research.summarize", sourceRef, instruction: "Follow the workflow." }),
    createInvocationEvent({ type: "direct_execute", selectableId: "mcp.tool", sourceRef }),
    createInvocationEvent({ type: "deepagents_handoff", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, boundary: "deepagents" }),
    createInvocationEvent({ type: "result", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, result: { ok: true } }),
    createInvocationEvent({ type: "error", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, error: createNormalizedInvocationError({ code: "RUNTIME_HANDOFF_UNAVAILABLE", message: "No runtime" }) }),
  ];

  assert.deepEqual(
    events.map((event) => event.type),
    INVOCATION_EVENT_TYPES,
  );
  assert.ok(events.every((event) => typeof event.timestamp === "string"));
});

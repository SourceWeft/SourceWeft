import assert from "node:assert/strict";
import { test } from "vitest";
import { createInvocationEvent } from "./events";
import { createNormalizedInvocationError } from "./errors";
import {
  INVOCATION_SOURCE_KINDS,
  type InvocationEvent,
  type InvocationSemantics,
  type InvocationSourceRef,
  type NormalizedInvocationError,
  type SelectableInvocationDefinition,
} from "./types";

test("invocation source refs distinguish capability and skill capabilities", () => {
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
  ];

  assert.deepEqual(
    refs.map((ref) => ref.kind),
    INVOCATION_SOURCE_KINDS,
  );
});

test("selectable definitions model supported invocation semantics without execution", () => {
  const semantics: InvocationSemantics[] = [
    {
      kind: "fixed_tool_choice",
      target: "capability_tool",
      toolName: "generate_image",
    },
    {
      kind: "context_injection",
      workflow: "Use the skill workflow before answering.",
    },
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
    ["fixed_tool_choice", "context_injection"],
  );
});

test("normalized invocation errors expose required error codes and source identity", () => {
  const error: NormalizedInvocationError = createNormalizedInvocationError({
    code: "SCHEMA_MISMATCH",
    message: "Structured args do not match the tool schema",
    sourceRef: {
      kind: "capability_tool",
      capabilityId: "sourceweft/generate-image",
      contributionId: "generate_image",
      sourcePackageName: null,
      toolName: "generate_image",
    },
    recoverable: false,
  });

  assert.equal(error.code, "SCHEMA_MISMATCH");
  assert.equal(error.sourceRef?.kind, "capability_tool");
  assert.equal(error.recoverable, false);
});

test("invocation events cover resolution, policy, approval, handoff, result, and error states", () => {
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
    createInvocationEvent({ type: "approval_required", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, approvalRef: "approval_1", reason: "High risk tool" }),
    createInvocationEvent({ type: "tool_choice_bound", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, toolName: "generate_image" }),
    createInvocationEvent({ type: "context_injected", selectableId: "skill.research.summarize", sourceRef, instruction: "Follow the workflow." }),
    createInvocationEvent({ type: "deepagents_handoff", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, boundary: "deepagents" }),
    createInvocationEvent({ type: "result", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, result: { ok: true } }),
    createInvocationEvent({ type: "error", selectableId: "cap:sourceweft/generate-image:generate_image", sourceRef, error: createNormalizedInvocationError({ code: "RUNTIME_HANDOFF_UNAVAILABLE", message: "No runtime" }) }),
  ];

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "resolve",
      "policy",
      "approval_required",
      "tool_choice_bound",
      "context_injected",
      "deepagents_handoff",
      "result",
      "error",
    ],
  );
  assert.ok(events.every((event) => typeof event.timestamp === "string"));
});

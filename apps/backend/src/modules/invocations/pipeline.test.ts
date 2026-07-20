import assert from "node:assert/strict";
import { test } from "vitest";
import { createSelectableInvocationRegistry } from "./registry";
import { runInvocationPipeline } from "./pipeline";
import { allowInvocation, askInvocationApproval, denyInvocation } from "./policy";
import type { SelectableInvocationDefinition } from "./types";

const capabilityDefinition: SelectableInvocationDefinition = {
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

function registry(definition: SelectableInvocationDefinition = capabilityDefinition) {
  return createSelectableInvocationRegistry({
    providers: [{ id: "fake", list: () => [definition] }],
  });
}

test("pipeline runs resolve, policy, tool choice, and DeepAgents handoff in order", () => {
  const output = runInvocationPipeline({
    registry: registry(),
    envelope: { selectableId: capabilityDefinition.id, userInput: "make image" },
    policyEvaluator: () => allowInvocation({ reason: "Allowed" }),
  });

  assert.equal(output.status, "handoff_ready");
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["resolve", "policy", "tool_choice_bound", "deepagents_handoff"],
  );
  assert.equal(output.status === "handoff_ready" ? output.plan.kind : null, "bind_tool_choice");
});

test("ask policy short-circuits before DeepAgents handoff", () => {
  const output = runInvocationPipeline({
    registry: registry(),
    envelope: { selectableId: capabilityDefinition.id, userInput: "make image" },
    policyEvaluator: ({ plan }) =>
      askInvocationApproval({
        reason: "Approval required",
        approvalRef: "approval_1",
        sourceRef: plan.sourceRef,
      }),
  });

  assert.equal(output.status, "approval_required");
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["resolve", "policy", "approval_required"],
  );
});

test("schema and manifest failures return normalized pipeline errors", () => {
  const output = runInvocationPipeline({
    registry: registry(),
    envelope: { selectableId: capabilityDefinition.id, userInput: "make image" },
    policyEvaluator: ({ plan }) =>
      denyInvocation({
        reason: "Schema mismatch",
        code: "SCHEMA_MISMATCH",
        sourceRef: plan.sourceRef,
      }),
  });

  assert.equal(output.status, "error");
  assert.equal(output.status === "error" ? output.error.code : null, "SCHEMA_MISMATCH");
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["resolve", "policy", "error"],
  );
});

test("pipeline returns unavailable selection errors without policy or handoff", () => {
  const output = runInvocationPipeline({
    registry: registry(),
    envelope: { selectableId: "missing", userInput: "make image" },
    policyEvaluator: () => allowInvocation({ reason: "Allowed" }),
  });

  assert.equal(output.status, "error");
  assert.equal(output.status === "error" ? output.error.code : null, "INVOCATION_NOT_FOUND");
  assert.deepEqual(output.events.map((event) => event.type), ["error"]);
});

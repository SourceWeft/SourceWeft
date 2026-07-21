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

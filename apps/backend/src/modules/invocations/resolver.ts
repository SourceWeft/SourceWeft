import { createNormalizedInvocationError } from "./errors";
import type { SelectableInvocationRegistry } from "./registry";
import type {
  InvocationEnvelope,
  InvocationPlan,
  NormalizedInvocationError,
  SelectableInvocationDefinition,
} from "./types";

export type InvocationResolveResult =
  | { ok: true; definition: SelectableInvocationDefinition; plan: InvocationPlan }
  | { ok: false; error: NormalizedInvocationError };

function createPlan(input: {
  definition: SelectableInvocationDefinition;
  envelope: InvocationEnvelope;
}): InvocationPlan {
  const { definition, envelope } = input;
  switch (definition.semantics.kind) {
    case "fixed_tool_choice":
      return {
        kind: "bind_tool_choice",
        selectableId: envelope.selectableId,
        sourceRef: definition.sourceRef,
        semantics: definition.semantics,
        userInput: envelope.userInput,
        metadata: definition.metadata,
      };
    case "context_injection":
      return {
        kind: "inject_context",
        selectableId: envelope.selectableId,
        sourceRef: definition.sourceRef,
        semantics: definition.semantics,
        userInput: envelope.userInput,
        metadata: definition.metadata,
      };
  }
}

export function resolveInvocationSelection(input: {
  registry: SelectableInvocationRegistry;
  envelope: InvocationEnvelope;
}): InvocationResolveResult {
  const definition = input.registry.resolve(input.envelope.selectableId);
  if (!definition) {
    return {
      ok: false,
      error: createNormalizedInvocationError({
        code: "INVOCATION_NOT_FOUND",
        message: `Invocation selection '${input.envelope.selectableId}' is not available`,
        recoverable: false,
      }),
    };
  }
  if (!definition.enabled) {
    return {
      ok: false,
      error: createNormalizedInvocationError({
        code: "INVOCATION_UNAVAILABLE",
        message: definition.unavailableReason ?? "Invocation selection is unavailable",
        sourceRef: definition.sourceRef,
        recoverable: false,
      }),
    };
  }
  return {
    ok: true,
    definition,
    plan: createPlan({
      definition,
      envelope: input.envelope,
    }),
  };
}

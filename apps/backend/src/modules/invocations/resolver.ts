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

function hasCompleteStructuredArgs(envelope: InvocationEnvelope) {
  return Boolean(
    envelope.structuredArgs && Object.keys(envelope.structuredArgs).length > 0,
  );
}

function createPlan(input: {
  definition: SelectableInvocationDefinition;
  envelope: InvocationEnvelope;
  directExecuteEligible: boolean;
}): InvocationPlan {
  const { definition, envelope } = input;
  switch (definition.semantics.kind) {
    case "fixed_tool_choice":
      if (
        definition.semantics.target === "mcp_tool" &&
        input.directExecuteEligible &&
        hasCompleteStructuredArgs(envelope)
      ) {
        return {
          kind: "direct_execute",
          selectableId: envelope.selectableId,
          sourceRef: definition.sourceRef,
          semantics: {
            kind: "direct_execute",
            requiresCompleteStructuredArgs: true,
            inputSchema: {},
          },
          structuredArgs: envelope.structuredArgs,
          metadata: definition.metadata,
        };
      }
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
    case "mcp_prompt":
      if (definition.sourceRef.kind !== "mcp_prompt") {
        throw createNormalizedInvocationError({
          code: "SCHEMA_MISMATCH",
          message: "MCP prompt semantics require mcp_prompt source ref",
          sourceRef: definition.sourceRef,
          recoverable: false,
        });
      }
      return {
        kind: "mcp_prompt",
        selectableId: envelope.selectableId,
        sourceRef: definition.sourceRef,
        semantics: definition.semantics,
        metadata: definition.metadata,
      };
    case "mcp_resource":
      if (definition.sourceRef.kind !== "mcp_resource") {
        throw createNormalizedInvocationError({
          code: "SCHEMA_MISMATCH",
          message: "MCP resource semantics require mcp_resource source ref",
          sourceRef: definition.sourceRef,
          recoverable: false,
        });
      }
      return {
        kind: "mcp_resource",
        selectableId: envelope.selectableId,
        sourceRef: definition.sourceRef,
        semantics: definition.semantics,
        metadata: definition.metadata,
      };
    case "direct_execute":
      return {
        kind: "direct_execute",
        selectableId: envelope.selectableId,
        sourceRef: definition.sourceRef,
        semantics: definition.semantics,
        structuredArgs: envelope.structuredArgs,
        metadata: definition.metadata,
      };
  }
}

export function resolveInvocationSelection(input: {
  registry: SelectableInvocationRegistry;
  envelope: InvocationEnvelope;
  directExecuteEligible?: boolean;
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
  if (
    definition.semantics.kind === "direct_execute" &&
    input.directExecuteEligible !== true
  ) {
    return {
      ok: false,
      error: createNormalizedInvocationError({
        code: "INVOCATION_UNAVAILABLE",
        message: "Direct invocation execution is not available in this path",
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
      directExecuteEligible: input.directExecuteEligible ?? false,
    }),
  };
}

import {
  allowInvocation,
  askInvocationApproval,
  denyInvocation,
  type InvocationPolicyDecision,
} from "./policy";
import type { InvocationPlan } from "./types";

export type InvocationMcpAvailabilityStatus =
  | "active"
  | "disabled"
  | "needs_auth"
  | "unreachable";

export type InvocationPolicyEvaluationInput = {
  plan: InvocationPlan;
  mcpStatus?: InvocationMcpAvailabilityStatus;
  manifestFresh?: boolean;
  schemaMatches?: boolean;
  skillEnabled?: boolean;
};

function planMetadata(plan: InvocationPlan) {
  return "metadata" in plan && plan.metadata && typeof plan.metadata === "object"
    ? (plan.metadata as Record<string, unknown>)
    : {};
}

function booleanMetadata(
  metadata: Record<string, unknown>,
  key: string,
  explicit: boolean | undefined,
) {
  return explicit ?? (typeof metadata[key] === "boolean" ? metadata[key] : undefined);
}

function mcpStatusMetadata(
  metadata: Record<string, unknown>,
  explicit: InvocationMcpAvailabilityStatus | undefined,
) {
  const value = metadata.mcpStatus;
  if (explicit) {
    return explicit;
  }
  return value === "active" ||
    value === "disabled" ||
    value === "needs_auth" ||
    value === "unreachable"
    ? value
    : undefined;
}

export function evaluateInvocationPolicy(
  input: InvocationPolicyEvaluationInput,
): InvocationPolicyDecision {
  if (input.plan.sourceRef.kind === "skill_command" && input.skillEnabled === false) {
    return denyInvocation({
      reason: "Skill command is not enabled",
      code: "SKILL_NOT_ENABLED",
      sourceRef: input.plan.sourceRef,
    });
  }

  if (input.plan.sourceRef.kind.startsWith("mcp_")) {
    const metadata = planMetadata(input.plan);
    const mcpStatus = mcpStatusMetadata(metadata, input.mcpStatus);
    const manifestFresh = booleanMetadata(
      metadata,
      "manifestFresh",
      input.manifestFresh,
    );
    const schemaMatches = booleanMetadata(
      metadata,
      "schemaMatches",
      input.schemaMatches,
    );
    if (!mcpStatus) {
      return denyInvocation({
        reason: "MCP capability status is unknown",
        code: "POLICY_DENIED",
        sourceRef: input.plan.sourceRef,
        metadata,
      });
    }
    if (mcpStatus === "disabled") {
      return denyInvocation({
        reason: "MCP capability is disabled",
        code: "POLICY_DENIED",
        sourceRef: input.plan.sourceRef,
      });
    }
    if (mcpStatus === "needs_auth") {
      return askInvocationApproval({
        reason: "MCP capability requires authentication",
        approvalRef: `${input.plan.selectableId}:auth`,
        sourceRef: input.plan.sourceRef,
      });
    }
    if (mcpStatus === "unreachable") {
      return denyInvocation({
        reason: "MCP server is unreachable",
        code: "POLICY_DENIED",
        sourceRef: input.plan.sourceRef,
      });
    }
    if (manifestFresh !== true) {
      return denyInvocation({
        reason: "MCP manifest snapshot is stale",
        code: "MCP_MANIFEST_STALE",
        sourceRef: input.plan.sourceRef,
      });
    }
    if (schemaMatches !== true) {
      return denyInvocation({
        reason: "Invocation structured args do not match MCP schema",
        code: "SCHEMA_MISMATCH",
        sourceRef: input.plan.sourceRef,
      });
    }
    if (
      metadata.risk === "high" ||
      metadata.risk === "write" ||
      metadata.risk === "destructive" ||
      metadata.risk === "unknown"
    ) {
      return askInvocationApproval({
        reason: "High-risk MCP capability requires approval",
        approvalRef: `${input.plan.selectableId}:approval`,
        sourceRef: input.plan.sourceRef,
        metadata,
      });
    }
  }

  return allowInvocation({ reason: "Invocation policy allowed" });
}

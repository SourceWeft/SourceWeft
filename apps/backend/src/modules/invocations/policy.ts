import { createNormalizedInvocationError } from "./errors";
import type {
  InvocationPlan,
  InvocationSourceRef,
  NormalizedInvocationErrorCode,
} from "./types";

export type InvocationPolicyDecision =
  | {
      decision: "allow";
      reason: string;
      metadata?: Record<string, unknown>;
    }
  | {
      decision: "deny";
      reason: string;
      error: ReturnType<typeof createNormalizedInvocationError>;
      metadata?: Record<string, unknown>;
    }
  | {
      decision: "ask";
      reason: string;
      approvalRef: string;
      sourceRef?: InvocationSourceRef;
      metadata?: Record<string, unknown>;
    };

export type InvocationPolicyContext = {
  workspaceId: string;
  userId: string;
  plan: InvocationPlan;
  metadata?: Record<string, unknown>;
};

export type InvocationPolicyEvaluator = {
  evaluate: (
    context: InvocationPolicyContext,
  ) => InvocationPolicyDecision | Promise<InvocationPolicyDecision>;
};

export function allowInvocation(input: {
  reason: string;
  metadata?: Record<string, unknown>;
}): InvocationPolicyDecision {
  return {
    decision: "allow",
    reason: input.reason,
    metadata: input.metadata,
  };
}

export function denyInvocation(input: {
  reason: string;
  code: NormalizedInvocationErrorCode;
  sourceRef?: InvocationSourceRef;
  metadata?: Record<string, unknown>;
}): InvocationPolicyDecision {
  return {
    decision: "deny",
    reason: input.reason,
    error: createNormalizedInvocationError({
      code: input.code,
      message: input.reason,
      sourceRef: input.sourceRef,
      recoverable: false,
      details: input.metadata,
    }),
    metadata: input.metadata,
  };
}

export function askInvocationApproval(input: {
  reason: string;
  approvalRef: string;
  sourceRef?: InvocationSourceRef;
  metadata?: Record<string, unknown>;
}): InvocationPolicyDecision {
  return {
    decision: "ask",
    reason: input.reason,
    approvalRef: input.approvalRef,
    sourceRef: input.sourceRef,
    metadata: input.metadata,
  };
}

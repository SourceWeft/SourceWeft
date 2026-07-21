import {
  allowInvocation,
  denyInvocation,
  type InvocationPolicyDecision,
} from "./policy";
import type { InvocationPlan } from "./types";

export type InvocationPolicyEvaluationInput = {
  plan: InvocationPlan;
  skillEnabled?: boolean;
};

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

  return allowInvocation({ reason: "Invocation policy allowed" });
}

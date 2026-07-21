import assert from "node:assert/strict";
import { test } from "vitest";
import {
  allowInvocation,
  askInvocationApproval,
  denyInvocation,
  type InvocationPolicyContext,
  type InvocationPolicyEvaluator,
} from "./policy";
import type { InvocationPlan } from "./types";

function capabilityToolPlan(): InvocationPlan {
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
    userInput: "make an image",
  };
}

test("policy decisions model allow, deny, and ask without throwing", () => {
  const allow = allowInvocation({ reason: "Low-risk built-in tool" });
  const deny = denyInvocation({
    reason: "Skill is not enabled",
    code: "SKILL_NOT_ENABLED",
  });
  const ask = askInvocationApproval({
    reason: "High-risk capability tool requires approval",
    approvalRef: "approval_1",
    sourceRef: capabilityToolPlan().sourceRef,
  });

  assert.equal(allow.decision, "allow");
  assert.equal(deny.decision, "deny");
  assert.equal(deny.error.code, "SKILL_NOT_ENABLED");
  assert.equal(ask.decision, "ask");
  assert.equal(ask.approvalRef, "approval_1");
  assert.equal(ask.sourceRef?.kind, "capability_tool");
});

test("ask includes approval reason and source metadata", () => {
  const ask = askInvocationApproval({
    reason: "High-risk capability tool requires approval",
    approvalRef: "approval_1",
    sourceRef: capabilityToolPlan().sourceRef,
    metadata: { risk: "high" },
  });

  assert.equal(ask.decision, "ask");
  assert.equal(ask.reason, "High-risk capability tool requires approval");
  assert.deepEqual(ask.metadata, { risk: "high" });
  assert.equal(
    ask.sourceRef?.kind === "capability_tool" ? ask.sourceRef.capabilityId : null,
    "sourceweft/generate-image",
  );
});

test("normal deny and ask flows are evaluator outputs, not generic exceptions", async () => {
  const evaluator: InvocationPolicyEvaluator = {
    evaluate(input: InvocationPolicyContext) {
      if (input.plan.kind === "bind_tool_choice") {
        return askInvocationApproval({
          reason: "Tool execution requires approval",
          approvalRef: "approval_1",
          sourceRef: input.plan.sourceRef,
        });
      }
      return allowInvocation({ reason: "Allowed" });
    },
  };

  const decision = await evaluator.evaluate({
    workspaceId: "workspace_1",
    userId: "user_1",
    plan: capabilityToolPlan(),
  });

  assert.equal(decision.decision, "ask");
});

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

function mcpDirectPlan(): InvocationPlan {
  return {
    kind: "direct_execute",
    selectableId: "mcp.mcp_install_1.tool.create_issue",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
    },
    semantics: {
      kind: "direct_execute",
      requiresCompleteStructuredArgs: true,
      inputSchema: { type: "object" },
    },
    structuredArgs: { title: "Bug" },
  };
}

test("policy decisions model allow, deny, and ask without throwing", () => {
  const allow = allowInvocation({ reason: "Low-risk built-in tool" });
  const deny = denyInvocation({
    reason: "Skill is not enabled",
    code: "SKILL_NOT_ENABLED",
  });
  const ask = askInvocationApproval({
    reason: "High-risk MCP tool requires approval",
    approvalRef: "approval_1",
    sourceRef: mcpDirectPlan().sourceRef,
  });

  assert.equal(allow.decision, "allow");
  assert.equal(deny.decision, "deny");
  assert.equal(deny.error.code, "SKILL_NOT_ENABLED");
  assert.equal(ask.decision, "ask");
  assert.equal(ask.approvalRef, "approval_1");
  assert.equal(ask.sourceRef?.kind, "mcp_tool");
});

test("ask includes approval reason and source metadata", () => {
  const ask = askInvocationApproval({
    reason: "High-risk MCP tool requires approval",
    approvalRef: "approval_1",
    sourceRef: mcpDirectPlan().sourceRef,
    metadata: { risk: "high" },
  });

  assert.equal(ask.decision, "ask");
  assert.equal(ask.reason, "High-risk MCP tool requires approval");
  assert.deepEqual(ask.metadata, { risk: "high" });
  assert.equal(
    ask.sourceRef?.kind === "mcp_tool" ? ask.sourceRef.serverInstallId : null,
    "mcp_install_1",
  );
});

test("normal deny and ask flows are evaluator outputs, not generic exceptions", async () => {
  const evaluator: InvocationPolicyEvaluator = {
    evaluate(input: InvocationPolicyContext) {
      if (input.plan.kind === "direct_execute") {
        return askInvocationApproval({
          reason: "Direct execution requires approval",
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
    plan: mcpDirectPlan(),
  });

  assert.equal(decision.decision, "ask");
});

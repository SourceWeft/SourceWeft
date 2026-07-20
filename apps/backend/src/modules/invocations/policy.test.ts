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

function mcpToolPlan(): InvocationPlan {
  return {
    kind: "bind_tool_choice",
    selectableId: "mcp.mcp_install_1.tool.create_issue",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
    },
    semantics: {
      kind: "fixed_tool_choice",
      target: "mcp_tool",
      toolName: "mcp__mcp_install_1__create_issue",
    },
    userInput: "create an issue",
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
    sourceRef: mcpToolPlan().sourceRef,
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
    sourceRef: mcpToolPlan().sourceRef,
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
      if (input.plan.kind === "bind_tool_choice") {
        return askInvocationApproval({
          reason: "MCP tool execution requires approval",
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
    plan: mcpToolPlan(),
  });

  assert.equal(decision.decision, "ask");
});

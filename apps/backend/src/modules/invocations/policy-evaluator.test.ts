import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateInvocationPolicy } from "./policy-evaluator";
import type { InvocationPlan } from "./types";

function mcpPlan(metadata: Record<string, unknown> = {}): InvocationPlan {
  return {
    kind: "bind_tool_choice",
    selectableId: "mcp_tool.mcp_install_1.github_create_issue",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_install_1",
      serverToolName: "create_issue",
    },
    semantics: {
      kind: "fixed_tool_choice",
      target: "mcp_tool",
      toolName: "mcp__mcp_install_1__github_create_issue",
    },
    userInput: "create issue",
    metadata: {
      mcpStatus: "active",
      manifestFresh: true,
      schemaMatches: true,
      ...metadata,
    },
  } as InvocationPlan;
}

function skillPlan(): InvocationPlan {
  return {
    kind: "inject_context",
    selectableId: "skill_command.research.summarize",
    sourceRef: {
      kind: "skill_command",
      skillSlug: "research",
      commandName: "summarize",
    },
    semantics: {
      kind: "context_injection",
      workflow: "Summarize sources.",
    },
    userInput: "summarize",
  };
}

test("policy evaluator denies disabled, needs-auth, and unreachable MCP capabilities", () => {
  assert.equal(
    evaluateInvocationPolicy({ plan: mcpPlan(), mcpStatus: "disabled" }).decision,
    "deny",
  );
  assert.equal(
    evaluateInvocationPolicy({ plan: mcpPlan(), mcpStatus: "needs_auth" }).decision,
    "ask",
  );
  assert.equal(
    evaluateInvocationPolicy({ plan: mcpPlan(), mcpStatus: "unreachable" }).decision,
    "deny",
  );
});

test("policy evaluator returns ask for high-risk MCP capabilities", () => {
  const decision = evaluateInvocationPolicy({
    plan: mcpPlan({ risk: "high" }),
    mcpStatus: "active",
  });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.reason, "High-risk MCP capability requires approval");
});

test("policy evaluator blocks stale manifests and schema mismatches before handoff", () => {
  const stale = evaluateInvocationPolicy({
    plan: mcpPlan(),
    mcpStatus: "active",
    manifestFresh: false,
  });
  const mismatch = evaluateInvocationPolicy({
    plan: mcpPlan(),
    mcpStatus: "active",
    manifestFresh: true,
    schemaMatches: false,
  });

  assert.equal(stale.decision, "deny");
  assert.equal(stale.decision === "deny" ? stale.error.code : null, "MCP_MANIFEST_STALE");
  assert.equal(mismatch.decision, "deny");
  assert.equal(mismatch.decision === "deny" ? mismatch.error.code : null, "SCHEMA_MISMATCH");
});

test("policy evaluator denies MCP capabilities with missing status proof", () => {
  const decision = evaluateInvocationPolicy({
    plan: mcpPlan({ mcpStatus: undefined }),
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.decision === "deny" ? decision.error.code : null, "POLICY_DENIED");
});

test("policy evaluator denies disabled skills", () => {
  const decision = evaluateInvocationPolicy({
    plan: skillPlan(),
    skillEnabled: false,
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.decision === "deny" ? decision.error.code : null, "SKILL_NOT_ENABLED");
});

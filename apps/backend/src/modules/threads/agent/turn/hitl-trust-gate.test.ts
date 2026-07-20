import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveConnectorActionForTrustRule: vi.fn(),
  createConnectorActionApprovalRequest: vi.fn(),
  resolveAgentToolTrustScope: vi.fn(),
  findAgentToolTrustRuleForScope: vi.fn(),
  touchAgentToolTrustRuleUse: vi.fn(),
}));

vi.mock("../../../connectors/agent-tools", () => ({
  approveConnectorActionForTrustRule: mocks.approveConnectorActionForTrustRule,
  createConnectorActionApprovalRequest:
    mocks.createConnectorActionApprovalRequest,
}));

vi.mock("../../../agent-confirmations/trust-rules", () => ({
  resolveAgentToolTrustScope: mocks.resolveAgentToolTrustScope,
  findAgentToolTrustRuleForScope: mocks.findAgentToolTrustRuleForScope,
  touchAgentToolTrustRuleUse: mocks.touchAgentToolTrustRuleUse,
}));

import {
  applyTrustedHitlApproval,
  resolveTrustedHitlApproval,
  type HitlInterruptRequest,
} from "./hitl-handler";

const connectorContext = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  userId: "user-1",
};

const connectorScope = {
  domain: "connector",
  toolName: "gmail_send_email",
  connectorId: "connector-1",
  targetType: null,
  targetId: null,
  riskLevel: "medium" as const,
};

function interrupt(names: string[]): HitlInterruptRequest {
  return {
    id: "interrupt-1",
    actionRequests: names.map((name) => ({ name, args: { to: "a@b.c" } })),
    reviewConfigs: names.map((name) => ({
      actionName: name,
      allowedDecisions: ["approve", "reject"],
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentToolTrustScope.mockResolvedValue(connectorScope);
  mocks.findAgentToolTrustRuleForScope.mockResolvedValue({ id: "trust_1" });
});

test("a fully covered interrupt resolves to approve decisions", async () => {
  const approval = await resolveTrustedHitlApproval({
    connectorContext,
    hitlInterrupts: [interrupt(["gmail_send_email"])],
  });
  assert.deepEqual(approval?.decisions, [{ type: "approve" }]);
  assert.equal(approval?.matches[0]?.trustRuleId, "trust_1");
  // Read-only: nothing is marked as used until the whole interrupt is covered.
  assert.equal(mocks.touchAgentToolTrustRuleUse.mock.calls.length, 0);
});

test("one uncovered action forces the prompt for the whole interrupt", async () => {
  mocks.findAgentToolTrustRuleForScope
    .mockResolvedValueOnce({ id: "trust_1" })
    .mockResolvedValueOnce(null);
  const approval = await resolveTrustedHitlApproval({
    connectorContext,
    hitlInterrupts: [interrupt(["gmail_send_email", "gmail_delete_email"])],
  });
  assert.equal(approval, null);
  assert.equal(mocks.touchAgentToolTrustRuleUse.mock.calls.length, 0);
});

test("an untrustable tool forces the prompt", async () => {
  mocks.resolveAgentToolTrustScope.mockResolvedValue(null);
  assert.equal(
    await resolveTrustedHitlApproval({
      connectorContext,
      hitlInterrupts: [interrupt(["mcp__github__create_issue"])],
    }),
    null,
  );
});

test("a failing trust lookup falls back to prompting rather than approving", async () => {
  mocks.findAgentToolTrustRuleForScope.mockRejectedValue(
    new Error("ECONNREFUSED"),
  );
  assert.equal(
    await resolveTrustedHitlApproval({
      connectorContext,
      hitlInterrupts: [interrupt(["gmail_send_email"])],
    }),
    null,
  );
});

test("applying a connector approval leaves an execution ref and marks the rule used", async () => {
  mocks.approveConnectorActionForTrustRule.mockResolvedValue({
    actionRunId: "action_run_1",
    connectorId: "connector-1",
    requestJson: { to: "a@b.c" },
    toolName: "gmail_send_email",
  });
  const approval = await resolveTrustedHitlApproval({
    connectorContext,
    hitlInterrupts: [interrupt(["gmail_send_email"])],
  });
  assert.ok(approval);

  const context = { ...connectorContext } as Parameters<
    typeof applyTrustedHitlApproval
  >[0]["connectorContext"];
  assert.equal(
    await applyTrustedHitlApproval({ approval, connectorContext: context }),
    true,
  );
  assert.deepEqual(context.actionExecutionCursor?.refs, [
    {
      actionRunId: "action_run_1",
      connectorId: "connector-1",
      requestJson: { to: "a@b.c" },
      toolName: "gmail_send_email",
    },
  ]);
  assert.deepEqual(mocks.touchAgentToolTrustRuleUse.mock.calls[0]?.[0], {
    trustRuleId: "trust_1",
    tenant: connectorContext,
  });
});

test("a non-connector approval needs no action run but is still marked used", async () => {
  mocks.resolveAgentToolTrustScope.mockResolvedValue({
    ...connectorScope,
    domain: "sandbox",
    toolName: "execute",
    connectorId: null,
  });
  const approval = await resolveTrustedHitlApproval({
    connectorContext,
    hitlInterrupts: [interrupt(["execute"])],
  });
  assert.ok(approval);
  assert.equal(
    await applyTrustedHitlApproval({
      approval,
      connectorContext: { ...connectorContext },
    }),
    true,
  );
  assert.equal(mocks.approveConnectorActionForTrustRule.mock.calls.length, 0);
  assert.equal(mocks.touchAgentToolTrustRuleUse.mock.calls.length, 1);
});

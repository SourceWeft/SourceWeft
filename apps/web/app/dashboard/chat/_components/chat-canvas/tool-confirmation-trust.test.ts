import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  type AgentToolTrustRule,
} from "@sourceweft/sdk";
import {
  buildTrustPayload,
  describeDecisionOutcome,
  getConfirmationDecisionOptions,
  hasAlwaysAllowOption,
  trustDurationChoices,
} from "./tool-confirmation-trust";

function trustRule(
  input: Partial<AgentToolTrustRule> = {},
): AgentToolTrustRule {
  return {
    id: "rule-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    domain: "connector",
    toolName: "tool-1",
    connectorId: "connector-1",
    targetType: null,
    targetId: null,
    allowedRiskLevels: ["high"],
    status: "active",
    expiresAt: "2026-08-20T00:00:00.000Z",
    createdFromConfirmationId: "confirmation-1",
    lastUsedAt: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...input,
  };
}

test("always-allow is offered only when the server listed it", () => {
  assert.equal(
    hasAlwaysAllowOption({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
      ],
    }),
    false,
  );
  assert.equal(
    hasAlwaysAllowOption({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
        { decision: "approve_always", label: "Always allow" },
      ],
    }),
    true,
  );
});

test("a confirmation without decisionOptions falls back to approve/reject only", () => {
  const options = getConfirmationDecisionOptions({ decisionOptions: [] });
  assert.deepEqual(
    options.map((option) => option.decision),
    ["reject", "approve"],
  );
  assert.equal(hasAlwaysAllowOption({ decisionOptions: [] }), false);
});

test("trust payload carries only a ttl, never a scope", () => {
  assert.deepEqual(buildTrustPayload("default"), {});
  const payload = buildTrustPayload("7d");
  assert.deepEqual(payload, { ttlSeconds: 7 * 24 * 60 * 60 });
  assert.equal("scope" in payload, false);
});

test("offered durations never exceed the contract maximum", () => {
  for (const choice of trustDurationChoices) {
    if (typeof choice.ttlSeconds === "number") {
      assert.ok(choice.ttlSeconds <= AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS);
    }
  }
  assert.ok(
    trustDurationChoices.some((choice) => choice.ttlSeconds === undefined),
    "the server default must remain selectable",
  );
});

test("an approve_always response with no trust rule does not claim anything was remembered", () => {
  const message = describeDecisionOutcome({
    decision: "approve_always",
    trustRule: null,
  });
  assert.match(message, /not remembered/i);
  assert.doesNotMatch(message, /automatically/i);
});

test("an approve_always response with a trust rule reports the expiry", () => {
  const message = describeDecisionOutcome({
    decision: "approve_always",
    trustRule: trustRule(),
    now: new Date("2026-07-21T00:00:00.000Z"),
  });
  assert.match(message, /approved automatically until/i);
  assert.doesNotMatch(message, /not remembered/i);
});

test("plain approve and reject copy is unchanged", () => {
  assert.equal(
    describeDecisionOutcome({ decision: "approve" }),
    "Approved in SourceWeft.",
  );
  assert.match(describeDecisionOutcome({ decision: "reject" }), /was not run/i);
});

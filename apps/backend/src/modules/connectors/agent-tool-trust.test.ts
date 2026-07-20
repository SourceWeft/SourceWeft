import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  agentToolTrustRuleMatches,
  resolveAgentToolTrustRuleExpiry,
} from "./agent-tool-trust";
import type { AgentToolTrustRuleRecord } from "./types";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function rule(
  overrides: Partial<AgentToolTrustRuleRecord> = {},
): AgentToolTrustRuleRecord {
  return {
    id: "trust_1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    domain: "connector",
    toolName: "gmail_send_email",
    connectorId: "connector-1",
    targetType: null,
    targetId: null,
    allowedRiskLevels: ["medium"],
    status: "active",
    expiresAt: "2026-08-21T12:00:00.000Z",
    createdFromConfirmationId: "action_run_1",
    lastUsedAt: null,
    createdAt: "2026-07-21T11:00:00.000Z",
    updatedAt: "2026-07-21T11:00:00.000Z",
    ...overrides,
  };
}

const request = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  domain: "connector",
  toolName: "gmail_send_email",
  connectorId: "connector-1",
  riskLevel: "medium" as const,
  now: NOW,
};

test("an active, unexpired, in-scope rule matches", () => {
  assert.equal(agentToolTrustRuleMatches(rule(), request), true);
});

test("an expired rule does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(
      rule({ expiresAt: "2026-07-21T11:59:59.999Z" }),
      request,
    ),
    false,
  );
});

test("a rule expiring exactly now does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(
      rule({ expiresAt: NOW.toISOString() }),
      request,
    ),
    false,
  );
});

test("an unparseable expiry is treated as expired", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ expiresAt: "not-a-date" }), request),
    false,
  );
});

test("a revoked rule does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ status: "revoked" }), request),
    false,
  );
});

test("a rule from another workspace does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ workspaceId: "workspace-2" }), request),
    false,
  );
});

test("a rule from another team does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ teamId: "team-2" }), request),
    false,
  );
});

test("another member's rule does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ userId: "user-2" }), request),
    false,
  );
});

test("a rule for one connector does not match a sibling connector", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ connectorId: "connector-2" }), request),
    false,
  );
  assert.equal(
    agentToolTrustRuleMatches(rule({ connectorId: null }), request),
    false,
  );
});

test("a rule for one target does not match an untargeted action", () => {
  assert.equal(
    agentToolTrustRuleMatches(
      rule({ targetType: "document", targetId: "doc-1" }),
      request,
    ),
    false,
  );
});

test("risk containment: a low-risk grant does not approve a higher-risk action", () => {
  const lowRiskRule = rule({ allowedRiskLevels: ["low"] });
  assert.equal(
    agentToolTrustRuleMatches(lowRiskRule, { ...request, riskLevel: "low" }),
    true,
  );
  assert.equal(
    agentToolTrustRuleMatches(lowRiskRule, { ...request, riskLevel: "medium" }),
    false,
  );
  assert.equal(
    agentToolTrustRuleMatches(lowRiskRule, { ...request, riskLevel: "high" }),
    false,
  );
});

test("a rule with no granted risk levels never matches", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ allowedRiskLevels: [] }), request),
    false,
  );
});

test("a rule for a different tool or domain does not match", () => {
  assert.equal(
    agentToolTrustRuleMatches(rule({ toolName: "gmail_delete_email" }), request),
    false,
  );
  assert.equal(
    agentToolTrustRuleMatches(rule({ domain: "sandbox" }), request),
    false,
  );
});

test("expiry defaults to a bounded window and is capped", () => {
  assert.equal(
    resolveAgentToolTrustRuleExpiry({ now: NOW }).getTime(),
    NOW.getTime() + AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS * 1000,
  );
  assert.equal(
    resolveAgentToolTrustRuleExpiry({ now: NOW, ttlSeconds: 60 }).getTime(),
    NOW.getTime() + 60_000,
  );
  assert.equal(
    resolveAgentToolTrustRuleExpiry({
      now: NOW,
      ttlSeconds: AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS * 10,
    }).getTime(),
    NOW.getTime() + AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS * 1000,
  );
});

import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentToolTrustRuleRecord: vi.fn(),
  findAgentToolTrustRuleRecord: vi.fn(),
  touchAgentToolTrustRuleRecord: vi.fn(),
  resolveConnectorActionTrustScope: vi.fn(),
  getAgentToolDefinition: vi.fn(),
}));

vi.mock("../connectors/repository", () => ({
  createAgentToolTrustRuleRecord: mocks.createAgentToolTrustRuleRecord,
  findAgentToolTrustRuleRecord: mocks.findAgentToolTrustRuleRecord,
  touchAgentToolTrustRuleRecord: mocks.touchAgentToolTrustRuleRecord,
}));

vi.mock("../connectors/agent-tools", () => ({
  resolveConnectorActionTrustScope: mocks.resolveConnectorActionTrustScope,
}));

vi.mock("@sourceweft/agent-tool-registry", () => ({
  getAgentToolDefinition: mocks.getAgentToolDefinition,
}));

import {
  findAgentToolTrustRuleForScope,
  narrowAgentToolTrustScope,
  recordAgentToolTrustRule,
  resolveAgentToolTrustScope,
  touchAgentToolTrustRuleUse,
  type AgentToolTrustScope,
} from "./trust-rules";
import { AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS } from "../connectors/agent-tool-trust";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const tenant = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  userId: "user-1",
};

const scope: AgentToolTrustScope = {
  domain: "connector",
  toolName: "gmail_send_email",
  connectorId: "connector-1",
  targetType: null,
  targetId: null,
  riskLevel: "medium",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectorActionTrustScope.mockResolvedValue(null);
  mocks.getAgentToolDefinition.mockReturnValue(null);
  mocks.createAgentToolTrustRuleRecord.mockImplementation(
    async (input: Record<string, unknown>) => ({ id: "trust_1", ...input }),
  );
});

test("connector scope wins over the registry entry so the connector id is recorded", async () => {
  mocks.resolveConnectorActionTrustScope.mockResolvedValue({
    domain: "connector",
    toolName: "gmail_send_email",
    connectorId: "connector-1",
    riskLevel: "medium",
  });
  mocks.getAgentToolDefinition.mockReturnValue({
    domain: "connector",
    riskLevel: "low",
  });

  assert.deepEqual(
    await resolveAgentToolTrustScope({
      args: {},
      context: tenant,
      toolName: "gmail_send_email",
    }),
    scope,
  );
});

test("a registry tool without a declared risk level is not trustable", async () => {
  mocks.getAgentToolDefinition.mockReturnValue({ domain: "sandbox" });
  assert.equal(
    await resolveAgentToolTrustScope({
      args: {},
      context: tenant,
      toolName: "execute",
    }),
    null,
  );
});

test("an unknown tool is not trustable", async () => {
  assert.equal(
    await resolveAgentToolTrustScope({
      args: {},
      context: tenant,
      toolName: "mcp__github__create_issue",
    }),
    null,
  );
});

test("lookup is tenant-scoped and passes the action risk level through", async () => {
  mocks.findAgentToolTrustRuleRecord.mockResolvedValue(null);
  await findAgentToolTrustRuleForScope({ scope, tenant, now: NOW });
  assert.deepEqual(mocks.findAgentToolTrustRuleRecord.mock.calls[0]?.[0], {
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    domain: "connector",
    toolName: "gmail_send_email",
    connectorId: "connector-1",
    targetType: null,
    targetId: null,
    riskLevel: "medium",
    now: NOW,
  });
});

test("using a rule records last-used against the owning tenant", async () => {
  mocks.touchAgentToolTrustRuleRecord.mockResolvedValue({ id: "trust_1" });
  await touchAgentToolTrustRuleUse({
    trustRuleId: "trust_1",
    tenant,
    now: NOW,
  });
  assert.deepEqual(mocks.touchAgentToolTrustRuleRecord.mock.calls[0]?.[0], {
    teamId: "team-1",
    workspaceId: "workspace-1",
    trustRuleId: "trust_1",
    lastUsedAt: NOW,
  });
});

test("create records the source confirmation id and contains the risk level", async () => {
  await recordAgentToolTrustRule({
    scope,
    tenant,
    confirmationId: "action_run_1",
    now: NOW,
  });
  const written = mocks.createAgentToolTrustRuleRecord.mock.calls[0]?.[0];
  assert.equal(written.createdFromConfirmationId, "action_run_1");
  assert.deepEqual(written.allowedRiskLevels, ["medium"]);
  assert.equal(written.status, "active");
  assert.equal(written.teamId, "team-1");
  assert.equal(written.workspaceId, "workspace-1");
  assert.equal(written.userId, "user-1");
  assert.equal(written.connectorId, "connector-1");
});

test("create always writes an expiry, defaulting when no TTL is asked for", async () => {
  await recordAgentToolTrustRule({
    scope,
    tenant,
    confirmationId: "action_run_1",
    now: NOW,
  });
  assert.equal(
    (
      mocks.createAgentToolTrustRuleRecord.mock.calls[0]?.[0]
        .expiresAt as Date
    ).getTime(),
    NOW.getTime() + AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS * 1000,
  );

  await recordAgentToolTrustRule({
    scope,
    tenant,
    confirmationId: "action_run_1",
    ttlSeconds: 3600,
    now: NOW,
  });
  assert.equal(
    (
      mocks.createAgentToolTrustRuleRecord.mock.calls[1]?.[0]
        .expiresAt as Date
    ).getTime(),
    NOW.getTime() + 3_600_000,
  );
});

test("target granularity only narrows when the confirmation carries a target", () => {
  const confirmation = {
    preview: { title: "t", target: { type: "document", label: "Doc", id: "doc-1" } },
  } as unknown as ToolConfirmationRequest;

  assert.deepEqual(
    narrowAgentToolTrustScope({ scope, granularity: "target", confirmation }),
    { ...scope, targetType: "document", targetId: "doc-1" },
  );
  assert.deepEqual(
    narrowAgentToolTrustScope({ scope, granularity: "target" }),
    scope,
  );
  assert.deepEqual(
    narrowAgentToolTrustScope({ scope, granularity: "tool", confirmation }),
    scope,
  );
});

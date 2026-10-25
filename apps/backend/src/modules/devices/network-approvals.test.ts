import { describe, expect, test, vi } from "vitest";

// The pure policy assembly is tested here; the persistence paths (ask, answer,
// expiry, delivery, tenancy) run against PostgreSQL in
// network-approvals.database.test.ts.
vi.mock("@sourceweft/db", () => ({
  db: {},
  localDevices: {},
  localNetworkRequests: {},
  localToolInvocations: {},
  threads: {},
}));
vi.mock("../connectors/repository/trust-rule", () => ({
  listAgentToolTrustRuleRecords: vi.fn(),
}));
vi.mock("../agent-confirmations/trust-rules", () => ({
  findAgentToolTrustRuleForScope: vi.fn(),
  recordAgentToolTrustRule: vi.fn(),
  touchAgentToolTrustRuleUse: vi.fn(),
}));
vi.mock("../connectors/permissions", () => ({
  requireConnectorWorkspace: vi.fn(),
}));
vi.mock("./access", () => ({ requireDeviceAccess: vi.fn() }));

import type { AgentToolTrustRuleRecord } from "../connectors/types";
import {
  allowPatternsFromRules,
  approvalExpiry,
  buildCommandNetworkPolicy,
  decisionFrameForRow,
  matchingNetworkRule,
  networkTrustScope,
  NETWORK_REASONS,
} from "./network-approvals";

const now = new Date("2026-10-25T12:00:00Z");
const rule = (
  overrides: Partial<AgentToolTrustRuleRecord> = {},
): AgentToolTrustRuleRecord => ({
  id: "rule",
  teamId: "team",
  workspaceId: "ws",
  userId: "user",
  domain: "network",
  toolName: "network_access",
  connectorId: null,
  targetType: "host",
  targetId: "api.example.com",
  allowedRiskLevels: ["medium"],
  status: "active",
  expiresAt: "2026-11-01T00:00:00.000Z",
  createdFromConfirmationId: null,
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

describe("networkTrustScope", () => {
  test("is a medium-risk host rule outside any connector", () => {
    expect(networkTrustScope("api.example.com")).toEqual({
      domain: "network",
      toolName: "network_access",
      connectorId: null,
      targetType: "host",
      targetId: "api.example.com",
      riskLevel: "medium",
    });
  });
});

describe("allowPatternsFromRules", () => {
  test("keeps only live network rules for a canonical host", () => {
    expect(
      allowPatternsFromRules(
        [
          rule(),
          rule({ id: "2", targetId: "b.example.com", expiresAt: null }),
          rule({ id: "3", status: "revoked", targetId: "revoked.example" }),
          rule({
            id: "4",
            expiresAt: "2026-10-25T11:59:59Z",
            targetId: "old.example",
          }),
          rule({
            id: "5",
            expiresAt: "garbage",
            targetId: "bad-expiry.example",
          }),
          rule({
            id: "6",
            domain: "connector",
            targetId: "other-domain.example",
          }),
          rule({
            id: "7",
            toolName: "execute",
            targetId: "other-tool.example",
          }),
          rule({ id: "8", targetType: "url", targetId: "wrong-type.example" }),
          rule({ id: "9", connectorId: "c", targetId: "connector.example" }),
          rule({
            id: "10",
            allowedRiskLevels: ["low"],
            targetId: "low.example",
          }),
          rule({
            id: "11",
            allowedRiskLevels: ["high"],
            targetId: "high.example",
          }),
          rule({ id: "12", targetId: null }),
          rule({ id: "13", targetId: "UPPER.example" }),
          rule({ id: "14", targetId: "*" }),
        ],
        now,
      ),
    ).toEqual(["api.example.com", "b.example.com"]);
  });
});

describe("matchingNetworkRule", () => {
  test("a rule covers every port of its exact host and nothing else", () => {
    const rules = [rule(), rule({ id: "other", targetId: "other.example" })];
    expect(matchingNetworkRule(rules, "api.example.com", 8443, now)?.id).toBe(
      "rule",
    );
    expect(matchingNetworkRule(rules, "other.example", 443, now)?.id).toBe(
      "other",
    );
    expect(
      matchingNetworkRule(rules, "x.api.example.com", 443, now),
    ).toBeUndefined();
    expect(matchingNetworkRule(rules, "example.com", 443, now)).toBeUndefined();
    expect(
      matchingNetworkRule(
        [rule({ expiresAt: "2026-10-25T11:00:00Z" })],
        "api.example.com",
        443,
        now,
      ),
    ).toBeUndefined();
  });
});

describe("buildCommandNetworkPolicy", () => {
  const skills = [
    {
      name: "pdf",
      sourceType: "builtin",
      skillMd: '---\nname: pdf\nnetwork-domains:\n  - "cdn.pdf.example"\n---',
    },
    {
      name: "mine",
      sourceType: "workspace_custom",
      skillMd: '---\nname: mine\nnetwork-domains:\n  - "evil.example"\n---',
    },
  ];

  test("ask: rules and trusted skills allow, untrusted skills only suggest", () => {
    expect(
      buildCommandNetworkPolicy({ mode: "ask", rules: [rule()], skills, now }),
    ).toEqual({
      mode: "ask",
      allow: ["api.example.com", "cdn.pdf.example"],
      suggested: { "evil.example": "mine" },
    });
  });

  test("strict keeps the allow list but still never asks (the device decides)", () => {
    expect(
      buildCommandNetworkPolicy({
        mode: "strict",
        rules: [rule()],
        skills,
        now,
      }),
    ).toMatchObject({
      mode: "strict",
      allow: ["api.example.com", "cdn.pdf.example"],
    });
  });

  test("open carries no list", () => {
    expect(
      buildCommandNetworkPolicy({ mode: "open", rules: [rule()], skills, now }),
    ).toEqual({ mode: "open", allow: [], suggested: {} });
  });

  test("duplicates collapse and the list is bounded", () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      rule({ id: `r${i}`, targetId: `h${i}.example.com` }),
    );
    const policy = buildCommandNetworkPolicy({
      mode: "ask",
      rules: [rule(), rule({ id: "dup" }), ...many],
      skills: [],
      now,
    });
    expect(policy.allow).toHaveLength(500);
    expect(new Set(policy.allow).size).toBe(500);
  });

  test("no skills and no rules is an empty ask policy", () => {
    expect(
      buildCommandNetworkPolicy({ mode: "ask", rules: [], skills: [], now }),
    ).toEqual({ mode: "ask", allow: [], suggested: {} });
  });
});

describe("decisionFrameForRow", () => {
  test("allowed carries no reason; denials always carry one", () => {
    expect(
      decisionFrameForRow({ askId: "a", status: "allowed", reason: null }),
    ).toEqual({ type: "network.decision", askId: "a", allow: true });
    expect(
      decisionFrameForRow({ askId: "a", status: "denied", reason: null }),
    ).toEqual({
      type: "network.decision",
      askId: "a",
      allow: false,
      reason: NETWORK_REASONS.denied,
    });
    expect(
      decisionFrameForRow({ askId: "a", status: "expired", reason: null }),
    ).toMatchObject({ allow: false, reason: NETWORK_REASONS.timedOut });
    expect(
      decisionFrameForRow({
        askId: "a",
        status: "expired",
        reason: NETWORK_REASONS.commandFinished,
      }),
    ).toMatchObject({ allow: false, reason: "command finished" });
  });

  test("a row that is somehow still pending is never an allow", () => {
    expect(
      decisionFrameForRow({ askId: "a", status: "pending", reason: null })
        .allow,
    ).toBe(false);
  });
});

describe("allow list sent to the device", () => {
  test("holds only entries the sandbox runtime keeps", () => {
    const policy = buildCommandNetworkPolicy({
      mode: "strict",
      rules: [
        rule({ id: "1", targetId: "api.example.com" }),
        rule({ id: "2", targetId: "intranet" }),
        rule({ id: "3", targetId: "2001:db8::1" }),
        rule({ id: "4", targetId: "8.8.8.8" }),
      ],
      skills: [
        {
          name: "pdf",
          sourceType: "builtin",
          skillMd: '---\nname: pdf\nnetwork-domains:\n  - "*.cdn.example"\n---',
        },
      ],
      now,
    });
    expect(policy.allow).toEqual([
      "api.example.com",
      "[2001:db8::1]",
      "8.8.8.8",
      "*.cdn.example",
    ]);
  });
});

describe("approvalExpiry", () => {
  const T = new Date("2026-10-25T12:00:00Z");
  test("is the approval window unless the command ends sooner", () => {
    expect(
      approvalExpiry(T, new Date(T.getTime() + 600_000)).toISOString(),
    ).toBe("2026-10-25T12:02:00.000Z");
    expect(
      approvalExpiry(T, new Date(T.getTime() + 30_000)).toISOString(),
    ).toBe("2026-10-25T12:00:30.000Z");
  });
  test("a missing or unusable deadline falls back to the window", () => {
    for (const deadline of [null, undefined, new Date("garbage")])
      expect(approvalExpiry(T, deadline).toISOString()).toBe(
        "2026-10-25T12:02:00.000Z",
      );
  });
  test("an already-passed deadline is not in the future", () => {
    expect(
      approvalExpiry(T, new Date(T.getTime() - 1)).getTime() <= T.getTime(),
    ).toBe(true);
  });
});

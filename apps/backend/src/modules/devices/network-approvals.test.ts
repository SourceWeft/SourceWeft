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
  MAX_NETWORK_ALLOW_ENTRIES,
  withAskKind,
  decisionFrameForRow,
  matchingNetworkRule,
  readAskShape,
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
      allow: ["cdn.pdf.example", "api.example.com"],
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
      allow: ["cdn.pdf.example", "api.example.com"],
    });
  });

  test("open carries no list", () => {
    expect(
      buildCommandNetworkPolicy({ mode: "open", rules: [rule()], skills, now }),
    ).toEqual({ mode: "open", allow: [], suggested: {} });
  });

  test("duplicates collapse and the list leaves room for the vault hosts the device adds", () => {
    // 300 + the desktop's 200 vault hosts stays within the runtime's 500.
    expect(MAX_NETWORK_ALLOW_ENTRIES).toBe(300);
    const many = Array.from({ length: 600 }, (_, i) =>
      rule({
        id: `r${i}`,
        targetId: `h${i}.example.com`,
        // r0 is the oldest, r599 the newest.
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }),
    );
    const policy = buildCommandNetworkPolicy({
      mode: "ask",
      rules: [rule(), rule({ id: "dup" }), ...many],
      skills: [
        {
          name: "pdf",
          sourceType: "builtin",
          skillMd:
            '---\nname: pdf\nnetwork-domains:\n  - "cdn.pdf.example"\n---',
        },
      ],
      now,
    });
    expect(policy.allow).toHaveLength(300);
    expect(new Set(policy.allow).size).toBe(300);
    // Skill domains are never the ones dropped; past the cap the oldest rules go.
    expect(policy.allow[0]).toBe("cdn.pdf.example");
    expect(policy.allow).toContain("h599.example.com");
    expect(policy.allow).not.toContain("h0.example.com");
    // Deterministic whatever order the rules arrive in.
    const reversed = buildCommandNetworkPolicy({
      mode: "ask",
      rules: [rule(), rule({ id: "dup" }), ...[...many].reverse()],
      skills: [
        {
          name: "pdf",
          sourceType: "builtin",
          skillMd:
            '---\nname: pdf\nnetwork-domains:\n  - "cdn.pdf.example"\n---',
        },
      ],
      now,
    });
    expect(reversed.allow).toEqual(policy.allow);
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

  test("answers about a write request echo the kind; host answers do not", () => {
    for (const status of ["allowed", "denied", "expired"] as const) {
      expect(
        decisionFrameForRow({
          askId: "a",
          status,
          reason: null,
          kind: "request",
        }),
        status,
      ).toMatchObject({
        type: "network.decision",
        askId: "a",
        kind: "request",
      });
      expect(
        decisionFrameForRow({ askId: "a", status, reason: null, kind: "host" }),
      ).not.toHaveProperty("kind");
      expect(
        decisionFrameForRow({ askId: "a", status, reason: null }),
      ).not.toHaveProperty("kind");
    }
    const deny = {
      type: "network.decision" as const,
      askId: "a",
      allow: false,
    };
    expect(withAskKind(deny, "request")).toEqual({ ...deny, kind: "request" });
    for (const other of ["host", "rule", undefined])
      expect(withAskKind(deny, other)).toEqual(deny);
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
    // Skill domains first, then rules newest first (ties by id).
    expect(policy.allow).toEqual([
      "*.cdn.example",
      "api.example.com",
      "[2001:db8::1]",
      "8.8.8.8",
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

describe("NETWORK_REASONS", () => {
  test("the user's denial text is pinned, and no other denial reuses it", () => {
    // The sidecar remembers non-user denials briefly but a user's denial for
    // the whole command; it tells them apart by this exact text. Its
    // USER_DENIAL_REASONS (sandbox-sidecar/src/network-policy.ts) must match.
    expect(NETWORK_REASONS.denied).toBe("denied by user");
    const userTexts = ["denied by user", "denied by the user"];
    for (const [name, reason] of Object.entries(NETWORK_REASONS))
      if (name !== "denied") expect(userTexts, name).not.toContain(reason);
  });
});

describe("readAskShape", () => {
  test("a plain ask is a host ask and may not carry request fields", () => {
    expect(readAskShape({})).toEqual({
      kind: "host",
      method: null,
      path: null,
      secretInBody: false,
    });
    expect(readAskShape({ kind: "host" })).toMatchObject({ kind: "host" });
    expect(readAskShape({ method: "POST" })).toBeNull();
    // The body flag belongs to write requests only.
    expect(readAskShape({ secretInBody: true })).toBeNull();
    expect(readAskShape({ kind: "host", secretInBody: true })).toBeNull();
    expect(readAskShape({ kind: "host", secretInBody: false })).toMatchObject({
      secretInBody: false,
    });
    expect(readAskShape({ kind: "host", path: "/x" })).toBeNull();
  });

  test("a request ask needs an upper-case method and an origin-form path", () => {
    expect(
      readAskShape({ kind: "request", method: "POST", path: "/v1/items/1" }),
    ).toEqual({
      kind: "request",
      method: "POST",
      path: "/v1/items/1",
      secretInBody: false,
    });
    expect(
      readAskShape({
        kind: "request",
        method: "POST",
        path: "/x",
        secretInBody: true,
      }),
    ).toMatchObject({ secretInBody: true });
    for (const bad of [
      { kind: "request" },
      { kind: "request", method: "POST" },
      { kind: "request", method: "post", path: "/x" },
      { kind: "request", method: "", path: "/x" },
      { kind: "request", method: "P".repeat(17), path: "/x" },
      { kind: "request", method: "PO ST", path: "/x" },
      { kind: "request", method: "POST", path: "" },
      { kind: "request", method: "POST", path: "x" },
      { kind: "request", method: "POST", path: "*" },
      { kind: "request", method: "POST", path: "http://evil.example/x" },
      { kind: "request", method: "POST", path: `/${"x".repeat(200)}` },
      { kind: "request", method: "POST", path: "/a\nb" },
      { kind: "request", method: "POST", path: "/a\u0000b" },
      { kind: "request", method: "POST", path: "/a\u007fb" },
      { kind: "rule", method: "POST", path: "/x" },
      { kind: "", method: "POST", path: "/x" },
    ])
      expect(readAskShape(bad), JSON.stringify(bad)).toBeNull();
    // The longest path allowed is exactly 200 characters.
    expect(
      readAskShape({
        kind: "request",
        method: "PUT",
        path: `/${"x".repeat(199)}`,
      }),
    ).not.toBeNull();
  });
});

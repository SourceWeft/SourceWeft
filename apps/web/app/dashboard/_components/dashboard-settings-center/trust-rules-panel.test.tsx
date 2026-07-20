// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentToolTrustRule } from "@sourceweft/sdk";

const listAgentToolTrustRules = vi.fn();
const revokeAgentToolTrustRule = vi.fn();

vi.mock("../../../../lib/sdk", () => ({
  connectorsClient: {
    listAgentToolTrustRules: (...args: unknown[]) =>
      listAgentToolTrustRules(...args),
    revokeAgentToolTrustRule: (...args: unknown[]) =>
      revokeAgentToolTrustRule(...args),
  },
}));

vi.mock("../../../../lib/auth-client", () => ({
  authClient: {
    useListOrganizations: () => ({ data: [] }),
    useActiveOrganization: () => ({ data: null }),
  },
}));

vi.mock("../../../../lib/dashboard-workspace-bootstrap", () => ({
  ensureDashboardWorkspace: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { TrustRulesPanelContent } from "./trust-rules-panel";

function rule(input: Partial<AgentToolTrustRule> = {}): AgentToolTrustRule {
  return {
    id: "rule-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    domain: "connector",
    toolName: "tool-alpha",
    connectorId: "connector-1",
    targetType: null,
    targetId: null,
    allowedRiskLevels: ["high"],
    status: "active",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdFromConfirmationId: "confirmation-1",
    lastUsedAt: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...input,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  await act(async () => {
    createdRoot.render(
      createElement(TrustRulesPanelContent, { workspaceId: "workspace-1" }),
    );
  });
  return container;
}

function rows(element: HTMLElement) {
  return [...element.querySelectorAll('[data-testid="trust-rule-row"]')];
}

beforeEach(() => {
  listAgentToolTrustRules.mockReset();
  revokeAgentToolTrustRule.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("lists a rule with the facts needed to judge it", async () => {
  listAgentToolTrustRules.mockResolvedValue({ rules: [rule()] });
  const element = await render();
  const listed = rows(element);
  assert.equal(listed.length, 1);
  const text = listed[0]?.textContent ?? "";
  assert.match(text, /tool-alpha/);
  assert.match(text, /connector-1/);
  assert.match(text, /high/);
  assert.match(text, /Never used/);
  assert.match(text, /confirmation-1/);
});

test("revoked rules are not listed", async () => {
  listAgentToolTrustRules.mockResolvedValue({
    rules: [rule({ id: "rule-2", status: "revoked" })],
  });
  const element = await render();
  assert.equal(rows(element).length, 0);
});

test("revoking removes the row", async () => {
  listAgentToolTrustRules.mockResolvedValue({
    rules: [rule(), rule({ id: "rule-2", toolName: "tool-beta" })],
  });
  revokeAgentToolTrustRule.mockResolvedValue({
    rule: rule({ status: "revoked" }),
  });
  const element = await render();
  assert.equal(rows(element).length, 2);

  const revokeButton = rows(element)[0]?.querySelector("button");
  assert.ok(revokeButton);
  await act(async () => {
    revokeButton.click();
  });

  assert.deepEqual(revokeAgentToolTrustRule.mock.calls[0], [
    "workspace-1",
    "rule-1",
  ]);
  const remaining = rows(element);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0]?.textContent ?? "", /tool-beta/);
});

test("no workspace means no request and an empty state", async () => {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  await act(async () => {
    createdRoot.render(
      createElement(TrustRulesPanelContent, { workspaceId: null }),
    );
  });
  assert.equal(listAgentToolTrustRules.mock.calls.length, 0);
  assert.equal(rows(container).length, 0);
  assert.match(container.textContent ?? "", /No remembered approvals/i);
});

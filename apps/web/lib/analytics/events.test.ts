import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const sent = vi.hoisted(() => ({
  trackEvent: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
}));

vi.mock("./client", () => ({ trackEvent: sent.trackEvent }));

import {
  setAnalyticsCatalog,
  trackArtifactShared,
  trackBadgeSnippetCopied,
  trackBeginCheckout,
  trackChatMessageSent,
  trackConnectorConnected,
  trackMcpServerInstalled,
  trackPurchase,
  trackSkillInstalled,
  trackSourceAdded,
  trackTeamCreated,
  trackWorkspaceCreated,
} from "./events";

afterEach(() => {
  sent.trackEvent.mockReset();
  setAnalyticsCatalog(null);
});

const catalog = {
  plans: {
    free: { credits: 3000, pages: 300 },
    pro: {
      credits: 8000,
      pages: 6000,
      priceCents: { monthly: 990, yearly: 9900 },
    },
    team: {
      credits: 8000,
      pages: 6000,
      priceCents: { monthly: 990, yearly: 9900 },
      minSeats: 2,
    },
  },
  topups: {
    credit: { units: 10000, priceCents: 1250 },
    page: { units: 1000, priceCents: 500 },
  },
};

test("trackBeginCheckout values come from the capabilities catalog", () => {
  setAnalyticsCatalog(catalog);
  trackBeginCheckout({
    billingInterval: "monthly",
    plan: "pro",
    source: "landing",
  });
  trackBeginCheckout({
    billingInterval: "yearly",
    plan: "team",
    seatCount: 3,
    source: "dashboard",
  });
  assert.equal(sent.trackEvent.mock.calls[0]![1]?.value, 9.9);
  assert.equal(sent.trackEvent.mock.calls[1]![1]?.value, 297);
});

test("trackBeginCheckout leaves the value out while no catalog is known", () => {
  trackBeginCheckout({
    billingInterval: "monthly",
    plan: "pro",
    source: "landing",
  });
  assert.equal(sent.trackEvent.mock.calls[0]![1]?.value, undefined);
});

test("trackBeginCheckout sends GA4 ecommerce fields", () => {
  trackBeginCheckout({
    billingInterval: "yearly",
    plan: "pro",
    source: "landing",
  });
  const [name, params] = sent.trackEvent.mock.calls[0]!;
  assert.equal(name, "begin_checkout");
  assert.equal(params?.currency, "USD");
  assert.deepEqual(
    (params?.items as { item_id: string }[])[0]?.item_id,
    "pro_yearly",
  );
});

test("trackPurchase skips the free plan", () => {
  trackPurchase({
    amountTotal: 0,
    billingInterval: null,
    currency: "usd",
    orderId: "order-1",
    planFamily: "free",
  });
  assert.equal(sent.trackEvent.mock.calls.length, 0);
});

test("trackChatMessageSent maps camelCase to snake_case", () => {
  trackChatMessageSent({
    commandUsed: true,
    hasImages: false,
    hasSources: true,
    skillCount: 2,
    sourceCount: 3,
    surface: "thread",
    toolCount: 1,
  });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "chat_message_sent",
    {
      command_used: true,
      has_images: false,
      has_sources: true,
      skill_count: 2,
      source_count: 3,
      surface: "thread",
      tool_count: 1,
    },
  ]);
});

test("trackConnectorConnected sends the connector type and gmail mode", () => {
  trackConnectorConnected({ connectorType: "gmail", gmailMode: "tools" });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "connector_connected",
    { connector_type: "gmail", gmail_mode: "tools" },
  ]);
});

test("trackMcpServerInstalled sends source and auth type", () => {
  trackMcpServerInstalled({ source: "market", authType: "oauth" });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "mcp_server_installed",
    { source: "market", auth_type: "oauth" },
  ]);
});

test("trackSourceAdded sends kind and count", () => {
  trackSourceAdded({ kind: "file", sourceCount: 3 });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "source_added",
    { kind: "file", source_count: 3 },
  ]);
});

test("trackArtifactShared and trackWorkspaceCreated send no params", () => {
  trackArtifactShared();
  trackWorkspaceCreated();
  assert.deepEqual(sent.trackEvent.mock.calls, [
    ["artifact_shared", {}],
    ["workspace_created", {}],
  ]);
});

test("trackSkillInstalled sends the surface", () => {
  trackSkillInstalled("gallery");
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "skill_installed",
    { surface: "gallery" },
  ]);
});

test("trackTeamCreated sends the edition", () => {
  trackTeamCreated("commercial");
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "team_created",
    { edition: "commercial" },
  ]);
});

test("trackBadgeSnippetCopied sends the kind, surface and snippet format", () => {
  trackBadgeSnippetCopied({
    kind: "mcp",
    method: "markdown",
    surface: "mcp_detail",
  });
  assert.deepEqual(sent.trackEvent.mock.calls[0], [
    "badge_snippet_copied",
    { kind: "mcp", method: "markdown", surface: "mcp_detail" },
  ]);
});

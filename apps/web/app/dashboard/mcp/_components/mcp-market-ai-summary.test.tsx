// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

import enMessages from "@/messages/en.json";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

import { McpMarket } from "./mcp-market";

const api = vi.hoisted(() => ({
  getWorkspaceMarketMcp: vi.fn(),
  getWorkspaceMarketMcpCategoryCounts: vi.fn(),
  listWorkspaceMarketMcp: vi.fn(),
  listWorkspaceMarketMcpCategories: vi.fn(),
}));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    hasWorkspaceHydrated: true,
    switchWorkspace: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Research",
    workspaces: [{ id: "ws-1", name: "Research" }],
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("../../chat/_components/sources-hub/mcp/use-mcp", () => ({
  invalidateWorkspaceMcpCache: vi.fn(),
}));
vi.mock("./submit-mcp-dialog", () => ({ SubmitMcpDialog: () => null }));
vi.mock("./mcp-credentials-dialog", () => ({ CredentialsDialog: () => null }));
vi.mock("./mcp-detail-dialog", () => ({ McpDetailDialog: () => null }));

function summary(identifier: string, name: string, aiSummary?: string) {
  return marketItemSummarySchema.parse({
    aiSummary,
    createdAt: "2026-09-01T00:00:00.000Z",
    id: `id-${identifier}`,
    identifier,
    latestVersion: "1.0.0",
    name,
    status: "published",
    summary: `${name} registry summary.`,
    updatedAt: "2026-09-15T00:00:00.000Z",
    verified: true,
    visibility: "public",
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  api.listWorkspaceMarketMcp.mockResolvedValue({
    items: [
      {
        install: null,
        market: summary("io.github.o/ai", "With AI", "AI summary of it."),
      },
      { install: null, market: summary("io.github.o/plain", "Plain") },
      { install: null, market: summary("io.github.o/blank", "Blank", "  ") },
    ],
    nextCursor: null,
  });
  api.listWorkspaceMarketMcpCategories.mockResolvedValue({ items: [] });
  api.getWorkspaceMarketMcpCategoryCounts.mockResolvedValue({
    counts: {},
    total: 3,
  });
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

describe("dashboard MCP market cards", { timeout: 30_000 }, () => {
  it("show the AI summary when there is one, and the registry summary otherwise", async () => {
    await mountWithIntl(<McpMarket />);
    await flush(4);
    expect(api.listWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ locale: "en" }),
    );

    const ai = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === "AI summary of it.",
    );
    expect(ai).toBeDefined();
    expect(ai!.hasAttribute("data-ai-summary")).toBe(true);
    expect(ai!.getAttribute("title")).toBe(
      enMessages.mcp.aiOverview.cardSummaryTitle,
    );
    expect(document.body.textContent).not.toContain(
      "With AI registry summary.",
    );

    for (const name of ["Plain", "Blank"]) {
      const plain = [...document.querySelectorAll("button")].find(
        (node) => node.textContent === `${name} registry summary.`,
      );
      expect(plain).toBeDefined();
      expect(plain!.hasAttribute("data-ai-summary")).toBe(false);
      expect(plain!.hasAttribute("title")).toBe(false);
    }
  });

  it("ask for the AI summaries in the viewer's language", async () => {
    await mountWithIntl(<McpMarket />, { locale: "zh-TW" });
    await flush(4);
    expect(api.listWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ locale: "zh-TW" }),
    );
  });
});

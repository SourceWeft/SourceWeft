// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

import enMessages from "@/messages/en.json";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
const overviews = vi.hoisted(() => ({
  getMarketAdminMe: vi.fn(),
  getMcpAiOverview: vi.fn(),
  getMcpOverviewAdmin: vi.fn(),
}));
const route = vi.hoisted(() => ({ identifier: "io.github.o/weather" }));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("../../../../lib/mcp-ai-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mcp-ai-overview")>()),
  ...overviews,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ identifier: route.identifier }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: "ws-1",
    workspaceName: "Research",
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("../../chat/_components/sources-hub/mcp/use-mcp", () => ({
  invalidateWorkspaceMcpCache: vi.fn(),
}));
vi.mock("../_components/mcp-credentials-dialog", () => ({
  CredentialsDialog: () => null,
}));

import McpDetailPage from "./page";

const DESCRIPTION = "Forecasts and alerts for any city.";

const detail = {
  install: null,
  market: {
    item: marketItemSummarySchema.parse({
      createdAt: "2026-09-01T00:00:00.000Z",
      id: "mcp-1",
      identifier: route.identifier,
      latestVersion: "1.0.0",
      name: "Weather",
      status: "published",
      summary: "Forecasts for any city.",
      toolsCount: 1,
      updatedAt: "2026-09-15T00:00:00.000Z",
      verified: true,
      visibility: "public",
    }),
    readme: null,
    versions: [
      {
        manifestJson: {
          description: DESCRIPTION,
          identifier: route.identifier,
          name: "Weather",
          schemaVersion: 1,
          summary: "Forecasts for any city.",
          tools: [{ name: "forecast", risk: "read" }],
          transport: "streamable_http",
          version: "1.0.0",
        },
        status: "published",
        version: "1.0.0",
      },
    ],
  },
};

const overview = {
  summary: "Weather lookups for trip planning.",
  whatItDoes: "Looks up forecasts and severe-weather alerts.",
  whenToUse: "When planning a trip.",
  requirements: "",
  cautions: null,
  locale: "en" as const,
  generatedAt: "2026-09-27T00:00:00.000Z",
};

async function open() {
  await mountWithIntl(<McpDetailPage />);
  await flush(6);
}

function activePanel() {
  return document.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"]',
  )!;
}

function adminPanel() {
  return document.querySelector<HTMLElement>(
    '[data-testid="mcp-overview-admin"]',
  );
}

beforeEach(() => {
  api.getWorkspaceMarketMcp.mockReset().mockResolvedValue(detail);
  overviews.getMcpAiOverview.mockReset().mockResolvedValue(overview);
  overviews.getMarketAdminMe.mockReset().mockResolvedValue(false);
  overviews.getMcpOverviewAdmin.mockReset().mockResolvedValue({
    entries: [
      {
        locale: "en",
        model: "deepseek-v4",
        hidden: false,
        generatedAt: "2026-09-27T00:00:00.000Z",
      },
    ],
    analysis: { status: "ready", error: null },
    categoriesSource: "ai",
    eligible: true,
    systemModel: { ready: true, reason: null },
  });
});
afterEach(async () => {
  await unmountAll();
});

describe("dashboard MCP detail page AI overview", () => {
  it("puts the AI overview at the top of the Overview tab, above the description", async () => {
    await open();
    expect(overviews.getMcpAiOverview).toHaveBeenCalledWith(
      route.identifier,
      "en",
    );
    const panel = activePanel();
    const block = panel.querySelector('[data-testid="mcp-ai-overview"]');
    expect(block).not.toBeNull();
    expect(panel.firstElementChild).toBe(block);
    expect(block!.textContent).toContain(enMessages.mcp.aiOverview.title);
    expect(panel.textContent).toContain(DESCRIPTION);
  });

  it("shows the overview admin panel beside it to a market admin", async () => {
    overviews.getMarketAdminMe.mockResolvedValue(true);
    await open();
    const panel = adminPanel();
    expect(panel).not.toBeNull();
    expect(panel!.closest("aside")).not.toBeNull();
    expect(overviews.getMcpOverviewAdmin).toHaveBeenCalledWith(
      route.identifier,
    );
    expect(panel!.textContent).toContain(enMessages.mcp.aiOverview.admin.title);
    expect(panel!.textContent).toContain("deepseek-v4");
  });

  it("shows no admin panel, and reads no admin state, for anyone else", async () => {
    await open();
    expect(overviews.getMarketAdminMe).toHaveBeenCalled();
    expect(adminPanel()).toBeNull();
    expect(overviews.getMcpOverviewAdmin).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      enMessages.mcp.aiOverview.admin.regenerate,
    );
  });
});

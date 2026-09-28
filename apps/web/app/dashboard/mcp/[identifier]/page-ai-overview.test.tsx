// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpOverviewAdminResponseSchema } from "@sourceweft/contracts";
import {
  marketItemSummarySchema,
  type MarketMcpAiOverview,
} from "@sourceweft/market-contracts";

import enMessages from "@/messages/en.json";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
const admin = vi.hoisted(() => ({
  getMarketAdminMe: vi.fn(),
  getMcpOverviewAdmin: vi.fn(),
}));
const route = vi.hoisted(() => ({ identifier: "io.github.o/weather" }));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("../../../../lib/mcp-ai-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mcp-ai-overview")>()),
  ...admin,
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

const overview: MarketMcpAiOverview = {
  summary: "Weather lookups for trip planning.",
  whatItDoes: "Looks up forecasts and severe-weather alerts.",
  whenToUse: "When planning a trip.",
  requirements: "",
  cautions: null,
  locale: "en",
  generatedAt: "2026-09-27T00:00:00.000Z",
};

/** The workspace detail: `market` is the public detail, AI overview included. */
function detail(aiOverview: MarketMcpAiOverview | null) {
  return {
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
      aiOverview,
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
}

const adminState = getMcpOverviewAdminResponseSchema.parse({
  identifier: route.identifier,
  serverId: "server-1",
  versionId: "version-1",
  version: "1.0.0",
  eligible: true,
  readmeStatus: "ok",
  inputSha256: "sha",
  skipReason: null,
  categoriesSource: "ai",
  analysis: null,
  overviews: [
    {
      locale: "en",
      overview: {
        summary: "s",
        whatItDoes: "w",
        whenToUse: "u",
        requirements: "",
        cautions: null,
        suggestedCategories: [],
      },
      model: "deepseek-v4",
      hidden: false,
      generatedAt: "2026-09-27T00:00:00.000Z",
      inputSha256: "sha",
      current: true,
    },
  ],
  systemModel: {
    enabled: true,
    configured: true,
    ready: true,
    provider: "openrouter",
    model: "deepseek/deepseek-v4",
    problems: [],
    reason: null,
  },
});

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
  api.getWorkspaceMarketMcp.mockReset().mockResolvedValue(detail(overview));
  admin.getMarketAdminMe.mockReset().mockResolvedValue(false);
  admin.getMcpOverviewAdmin.mockReset().mockResolvedValue(adminState);
});
afterEach(async () => {
  await unmountAll();
});

describe("dashboard MCP detail page AI overview", () => {
  it("puts the AI overview at the top of the Overview tab, above the description", async () => {
    await open();
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      route.identifier,
      { locale: "en" },
    );
    const panel = activePanel();
    const block = panel.querySelector('[data-testid="mcp-ai-overview"]');
    expect(block).not.toBeNull();
    expect(panel.firstElementChild).toBe(block);
    expect(block!.textContent).toContain(enMessages.mcp.aiOverview.title);
    expect(panel.textContent).toContain(DESCRIPTION);
  });

  it("shows the Overview tab as before without an overview", async () => {
    api.getWorkspaceMarketMcp.mockResolvedValue(detail(null));
    await open();
    expect(
      activePanel().querySelector('[data-testid="mcp-ai-overview"]'),
    ).toBeNull();
    expect(activePanel().textContent).toContain(DESCRIPTION);
  });

  it("shows the overview admin panel beside it to a market admin", async () => {
    admin.getMarketAdminMe.mockResolvedValue(true);
    await open();
    const panel = adminPanel();
    expect(panel).not.toBeNull();
    expect(panel!.closest("aside")).not.toBeNull();
    expect(admin.getMcpOverviewAdmin).toHaveBeenCalledWith(route.identifier);
    expect(panel!.textContent).toContain(enMessages.mcp.aiOverview.admin.title);
    expect(panel!.textContent).toContain("deepseek-v4");
  });

  it("shows no admin panel, and reads no admin state, for anyone else", async () => {
    await open();
    expect(admin.getMarketAdminMe).toHaveBeenCalled();
    expect(adminPanel()).toBeNull();
    expect(admin.getMcpOverviewAdmin).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      enMessages.mcp.aiOverview.admin.regenerate,
    );
  });
});

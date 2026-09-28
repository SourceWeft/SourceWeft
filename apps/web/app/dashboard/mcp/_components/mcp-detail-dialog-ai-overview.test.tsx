// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  marketItemSummarySchema,
  type MarketMcpAiOverview,
} from "@sourceweft/market-contracts";

import enMessages from "@/messages/en.json";
import zhTWMessages from "@/messages/zh-TW.json";
import {
  flush,
  type IntlOptions,
  mountWithIntl,
  unmountAll,
} from "@/test/react";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));

import { McpDetailDialog } from "./mcp-detail-dialog";

const IDENTIFIER = "io.github.o/weather";
const DESCRIPTION = "Forecasts and alerts for any city.";

const summary = marketItemSummarySchema.parse({
  createdAt: "2026-09-01T00:00:00.000Z",
  id: "mcp-1",
  identifier: IDENTIFIER,
  latestVersion: "1.0.0",
  name: "Weather",
  status: "published",
  summary: "Forecasts for any city.",
  toolsCount: 1,
  updatedAt: "2026-09-15T00:00:00.000Z",
  verified: true,
  visibility: "public",
});

const overview: MarketMcpAiOverview = {
  summary: "Weather lookups for trip planning.",
  whatItDoes: "Looks up forecasts and severe-weather alerts.",
  whenToUse: "When planning a trip.",
  requirements: "",
  cautions: "Sends city names to a third-party service.",
  locale: "en",
  generatedAt: "2026-09-27T00:00:00.000Z",
};

/** The workspace detail: `market` is the public detail, AI overview included. */
function detail(aiOverview: MarketMcpAiOverview | null) {
  return {
    install: null,
    market: {
      item: summary,
      readme: null,
      aiOverview,
      versions: [
        {
          manifestJson: {
            description: DESCRIPTION,
            identifier: IDENTIFIER,
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

async function open(options?: IntlOptions) {
  await mountWithIntl(
    <McpDetailDialog
      item={{ install: null, market: summary }}
      onConfigure={vi.fn()}
      onInstall={vi.fn()}
      onOpenChange={vi.fn()}
      onTest={vi.fn()}
      onToggleEnabled={vi.fn()}
      onUninstall={vi.fn()}
      pending={false}
      workspaceId="ws-1"
    />,
    options,
  );
  await flush(4);
}

function activePanel() {
  return document.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"]',
  )!;
}

beforeEach(() => {
  api.getWorkspaceMarketMcp.mockReset();
});
afterEach(async () => {
  await unmountAll();
});

describe("MCP detail dialog AI overview", () => {
  it("opens the Overview tab with the AI overview at its top, above the description", async () => {
    api.getWorkspaceMarketMcp.mockResolvedValue(detail(overview));
    await open();
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith("ws-1", IDENTIFIER, {
      locale: "en",
    });

    const panel = activePanel();
    const block = panel.querySelector<HTMLElement>(
      '[data-testid="mcp-ai-overview"]',
    );
    expect(block).not.toBeNull();
    expect(panel.firstElementChild).toBe(block);
    expect(block!.textContent).toContain(enMessages.mcp.aiOverview.title);
    expect(block!.textContent).toContain(enMessages.market.overview.cautions);
    // The author's description stays, below it.
    expect(panel.textContent).toContain(DESCRIPTION);
    expect(
      panel.textContent!.indexOf("Weather lookups for trip planning."),
    ).toBeLessThan(panel.textContent!.indexOf(DESCRIPTION));
  });

  it("asks in the viewer's language and notes an English fallback", async () => {
    api.getWorkspaceMarketMcp.mockResolvedValue(detail(overview));
    await open({
      locale: "zh-TW",
      messages: zhTWMessages as IntlOptions["messages"],
    });
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith("ws-1", IDENTIFIER, {
      locale: "zh-TW",
    });
    expect(
      activePanel().querySelector('[data-testid="mcp-ai-overview"]')
        ?.textContent,
    ).toContain(zhTWMessages.mcp.aiOverview.englishFallback);
  });

  it("shows the Overview tab as before without an overview", async () => {
    api.getWorkspaceMarketMcp.mockResolvedValue(detail(null));
    await open();
    const panel = activePanel();
    expect(panel.querySelector('[data-testid="mcp-ai-overview"]')).toBeNull();
    expect(panel.textContent).toContain(DESCRIPTION);
  });
});

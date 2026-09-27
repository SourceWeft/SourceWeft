// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "@/messages/en.json";
import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";

// The explainer lives in a tooltip that only mounts when opened, and an open
// Radix tooltip never settles in jsdom: render its content in place.
vi.mock("@sourceweft/ui-web/components/ui/tooltip", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@sourceweft/ui-web/components/ui/tooltip")
  >()),
  TooltipContent: ({ children }: { children?: ReactNode }) => (
    <div data-slot="tooltip-content">{children}</div>
  ),
}));

import type { MarketMcpAiOverview } from "@/lib/mcp-ai-overview";
import { type IntlOptions, mountWithIntl, unmountAll } from "@/test/react";

import { McpAiOverviewView } from "./mcp-ai-overview-view";

type IntlMessages = IntlOptions["messages"];
const catalogs = {
  en: enMessages,
  "zh-CN": zhCNMessages,
  "zh-TW": zhTWMessages,
} as const;

const overview: MarketMcpAiOverview = {
  summary: "Forecasts and alerts for any city.",
  whatItDoes: "Looks up forecasts and severe-weather alerts.",
  whenToUse: "When planning a trip or an outdoor event.",
  requirements: "An API key from the weather service.",
  cautions: "Sends the cities you ask about to a third-party service.",
  locale: "en",
  generatedAt: "2026-09-27T00:00:00.000Z",
};

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
});

async function render(node: ReactNode, locale: keyof typeof catalogs = "en") {
  ({ container } = await mountWithIntl(node, {
    locale,
    messages: catalogs[locale] as IntlMessages,
  }));
  return container.querySelector<HTMLElement>(
    '[data-testid="mcp-ai-overview"]',
  );
}

describe("McpAiOverviewView", () => {
  it("shows the overview labelled as AI-generated, with the MCP explainer and its cautions", async () => {
    const block = await render(<McpAiOverviewView overview={overview} />);
    const copy = enMessages.mcp.aiOverview;
    expect(block?.getAttribute("aria-label")).toBe(copy.title);
    expect(block?.textContent).toContain(copy.title);
    expect(
      block?.querySelector(`button[aria-label="${copy.explainerLabel}"]`),
    ).not.toBeNull();
    expect(block?.textContent).toContain(copy.explainer);
    expect(copy.explainer).toContain("server");
    for (const text of [
      overview.summary,
      copy.whatItDoes,
      overview.whatItDoes,
      copy.whenToUse,
      overview.whenToUse,
      copy.requirements,
      overview.requirements,
    ]) {
      expect(block?.textContent).toContain(text);
    }
    const cautions = block?.querySelector(
      '[data-testid="catalog-ai-overview-cautions"]',
    );
    expect(cautions?.getAttribute("role")).toBe("note");
    expect(cautions?.textContent).toContain(
      enMessages.market.overview.cautions,
    );
    expect(cautions?.textContent).toContain(overview.cautions);
  });

  it("leaves the cautions note out when there are none", async () => {
    const block = await render(
      <McpAiOverviewView overview={{ ...overview, cautions: null }} />,
    );
    expect(
      block?.querySelector('[data-testid="catalog-ai-overview-cautions"]'),
    ).toBeNull();
    expect(block?.textContent).not.toContain(
      enMessages.market.overview.cautions,
    );
  });

  it("keeps model text as plain text", async () => {
    const block = await render(
      <McpAiOverviewView
        overview={{
          ...overview,
          whatItDoes: "<img src=x onerror=alert(1)> [link](https://x.test)",
          cautions: "<script>alert(1)</script>",
        }}
      />,
    );
    expect(block?.querySelector("img, a, script")).toBeNull();
    expect(block?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(block?.textContent).toContain("<script>alert(1)</script>");
  });

  it("notes an English fallback in the reader's language, and only then", async () => {
    let block = await render(
      <McpAiOverviewView overview={overview} requestedLocale="zh-CN" />,
      "zh-CN",
    );
    expect(block?.textContent).toContain(zhCNMessages.mcp.aiOverview.title);
    expect(block?.textContent).toContain(
      zhCNMessages.mcp.aiOverview.englishFallback,
    );
    await unmountAll();

    block = await render(
      <McpAiOverviewView
        overview={{ ...overview, locale: "zh-TW" }}
        requestedLocale="zh-TW"
      />,
      "zh-TW",
    );
    expect(block?.textContent).toContain(zhTWMessages.mcp.aiOverview.title);
    expect(block?.textContent).toContain(zhTWMessages.mcp.aiOverview.whenToUse);
    expect(block?.textContent).toContain(zhTWMessages.market.overview.cautions);
    expect(block?.textContent).not.toContain(
      zhTWMessages.mcp.aiOverview.englishFallback,
    );
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MarketMcpToolsReference } from "@sourceweft/market-contracts";

const state = vi.hoisted(() => ({ locale: "en" }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const catalogs = {
    en: (await import("../../../../messages/en.json")).default,
    "zh-CN": (await import("../../../../messages/zh-CN.json")).default,
    "zh-TW": (await import("../../../../messages/zh-TW.json")).default,
  } as const;
  return {
    ...actual,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: state.locale,
        messages: catalogs[state.locale as keyof typeof catalogs],
        namespace: namespace as never,
      }),
  };
});
vi.mock("./mcp-display", () => ({
  formatDate: (value: string) => value.slice(0, 10),
}));

import { McpToolsReference } from "./mcp-tools-reference";

const platform: MarketMcpToolsReference = {
  source: "platform-indexed",
  observedAt: "2026-10-24T10:00:00.000Z",
  stale: false,
};

function render(reference: MarketMcpToolsReference, locale = "en") {
  state.locale = locale;
  return renderToStaticMarkup(<McpToolsReference reference={reference} />);
}

describe("tools reference note", () => {
  it("says the platform read the list with a standard test account, and when", () => {
    const html = render(platform);
    expect(html).toContain("Read by SourceWeft with a standard test account · 2026-10-24");
    expect(html).toContain('data-stale="false"');
    expect(html).not.toContain("server address changed");
  });

  it("flags a list read from an address the listing no longer has", () => {
    const html = render({ ...platform, stale: true });
    expect(html).toContain("The server address changed since this was read.");
    expect(html).toContain('data-stale="true"');
  });

  it("says a members' observation can differ by account", () => {
    const html = render({
      source: "member-observed",
      observedAt: "2026-10-24T00:00:00.000Z",
      stale: false,
    });
    expect(html).toContain("Observed through connected accounts · 2026-10-24");
    expect(html).toContain("It can differ by account.");
  });

  it.each(["zh-CN", "zh-TW"])("is translated in %s", (locale) => {
    const html = render({ ...platform, stale: true }, locale);
    expect(html).not.toContain("Read by SourceWeft");
    expect(html).toContain("2026-10-24");
    expect(html).toMatch(/SourceWeft/);
    expect(html).toMatch(locale === "zh-CN" ? /服务器地址/ : /伺服器地址/);
  });
});

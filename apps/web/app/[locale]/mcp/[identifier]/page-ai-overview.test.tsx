import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketMcpManifestResponseSchema } from "@sourceweft/market-contracts";

import enMessages from "../../../../messages/en.json";
import zhCNMessages from "../../../../messages/zh-CN.json";
import type { MarketMcpAiOverview } from "../../../../lib/mcp-ai-overview";

const market = vi.hoisted(() => ({
  getPublicMcpDetail: vi.fn(),
  getPublicMcpManifest: vi.fn(),
  listPublicMcp: vi.fn(),
  listPublicMcpCategories: vi.fn(),
}));
const overviews = vi.hoisted(() => ({
  getPublicMcpAiOverview: vi.fn(),
  getPublicMcpOverviewLocales: vi.fn(),
}));
// The locale the page is rendered in; the translators below follow it.
const intl = vi.hoisted(() => ({ locale: "en" }));

vi.mock("../../../../lib/market-mcp", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
vi.mock("../../../../lib/market-mcp-overview", () => overviews);
vi.mock("../../../_landing/auth-state-server", () => ({
  resolveInitialLandingAuthState: async () => ({
    isPending: false,
    isSignedIn: false,
    user: null,
  }),
}));
vi.mock("../../../_landing/components/sourceweft-header", () => ({
  SourceWeftHeader: () => null,
}));
vi.mock("../../../_landing/components/sourceweft-footer", () => ({
  SourceWeftFooter: () => null,
}));
// Async server components, which renderToStaticMarkup cannot render; this
// suite is about the overview around them.
vi.mock("../_components/mcp-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_components/mcp-display")>()),
  McpCardGrid: () => null,
  McpRuntimeBadge: () => null,
  McpToolRows: () => null,
  McpVerificationBadge: () => null,
}));

async function catalog(locale: string) {
  const { deepMergeMessages } = await import("@sourceweft/i18n/catalog");
  const en = (await import("../../../../messages/en.json")).default;
  if (locale === "en") return en;
  const translated = (await import(`../../../../messages/${locale}.json`))
    .default;
  return deepMergeMessages(en, translated) as typeof en;
}

// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real catalogs directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getTranslations: async (
      input?: string | { locale?: string; namespace?: string },
    ) => {
      const locale =
        (typeof input === "object" && input?.locale) || intl.locale;
      return createTranslator({
        locale,
        messages: await catalog(locale),
        namespace: (typeof input === "string"
          ? input
          : input?.namespace) as never,
      });
    },
    setRequestLocale: () => {},
  };
});
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    en: (await import("../../../../messages/en.json")).default,
    "zh-CN": await catalog("zh-CN"),
  };
  return {
    ...actual,
    useLocale: () => intl.locale,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: intl.locale,
        messages: messages[intl.locale as keyof typeof messages],
        namespace: namespace as never,
      }),
  };
});

import PublicMcpDetailPage, { generateMetadata } from "./page";
import { SITE_URL } from "../../../seo";

const IDENTIFIER = "io.github.o/weather";
const PATH = `/mcp/${encodeURIComponent(IDENTIFIER)}`;
const DESCRIPTION = "Forecasts, alerts and air quality for any city.";

const manifestResponse = getMarketMcpManifestResponseSchema.parse({
  item: {
    createdAt: "2026-09-01T00:00:00.000Z",
    id: "mcp-1",
    identifier: IDENTIFIER,
    name: "Weather",
    repoUrl: "https://github.com/o/r",
    status: "published",
    summary: "Forecasts for any city.",
    updatedAt: "2026-09-15T00:00:00.000Z",
    visibility: "public",
  },
  manifest: {
    identifier: IDENTIFIER,
    name: "Weather",
    schemaVersion: 1,
    summary: "Forecasts for any city.",
    description: DESCRIPTION,
    endpointUrl: "https://weather.example/mcp",
    tools: [{ name: "forecast" }],
    transport: "streamable_http",
    version: "1.0.0",
  },
  version: { manifestJson: {}, status: "published", version: "1.0.0" },
});

function overview(
  patch: Partial<MarketMcpAiOverview> = {},
): MarketMcpAiOverview {
  return {
    summary: "Weather lookups for trip planning.",
    whatItDoes: "Looks up forecasts and severe-weather alerts.",
    whenToUse: "When planning a trip or an outdoor event.",
    requirements: "An API key from the weather service.",
    cautions: "Sends the cities you ask about to a third-party service.",
    locale: "en",
    generatedAt: "2026-09-27T00:00:00.000Z",
    ...patch,
  };
}

function withOverview(aiOverview: MarketMcpAiOverview | null) {
  overviews.getPublicMcpAiOverview.mockResolvedValue({
    aiOverview,
    overviewLocales: null,
  });
}

async function render(locale = "en") {
  intl.locale = locale;
  const element = await PublicMcpDetailPage({
    params: Promise.resolve({
      identifier: encodeURIComponent(IDENTIFIER),
      locale,
    }),
  });
  return renderToStaticMarkup(element);
}

/** The Overview section, up to the next one. */
function overviewSection(html: string) {
  const start = html.indexOf('id="overview"');
  if (start < 0) return null;
  return html.slice(start, html.indexOf('id="installation"'));
}

function navLabels(html: string, label: string) {
  const nav = new RegExp(
    `<nav aria-label="${label}"[^>]*>([\\s\\S]*?)</nav>`,
  ).exec(html)![1]!;
  return [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
}

beforeEach(() => {
  intl.locale = "en";
  market.getPublicMcpManifest.mockReset().mockResolvedValue(manifestResponse);
  market.getPublicMcpDetail
    .mockReset()
    .mockResolvedValue({ readme: null, versions: [] });
  market.listPublicMcp.mockReset().mockResolvedValue({ items: [] });
  market.listPublicMcpCategories.mockReset().mockResolvedValue({ items: [] });
  overviews.getPublicMcpAiOverview.mockReset();
  overviews.getPublicMcpOverviewLocales.mockReset().mockResolvedValue([]);
  withOverview(null);
});

describe("public MCP detail page AI overview", () => {
  it("shows the overview in the Overview section in place of the description, labelled AI-generated", async () => {
    withOverview(overview());
    const html = await render();
    expect(overviews.getPublicMcpAiOverview).toHaveBeenCalledWith(
      IDENTIFIER,
      "en",
    );
    expect(navLabels(html, "Sections")[0]).toBe("overview");

    const section = overviewSection(html)!;
    const copy = enMessages.mcp.aiOverview;
    expect(section).toContain('data-testid="mcp-ai-overview"');
    expect(section).toContain(`aria-label="${copy.title}"`);
    expect(section).toContain(`aria-label="${copy.explainerLabel}"`);
    expect(section).toContain("Weather lookups for trip planning.");
    expect(section).toContain(copy.whenToUse);
    expect(section).toContain(enMessages.market.overview.cautions);
    expect(section).toContain(
      "Sends the cities you ask about to a third-party service.",
    );
    // In the language asked for: no fallback note.
    expect(section).not.toContain(copy.englishFallback);
    // The author's description is not shown beside it, nor changed.
    expect(section).not.toContain(DESCRIPTION);
  });

  it("leaves the cautions note out when the overview has none", async () => {
    withOverview(overview({ cautions: null }));
    const section = overviewSection(await render())!;
    expect(section).toContain('data-testid="mcp-ai-overview"');
    expect(section).not.toContain("catalog-ai-overview-cautions");
    expect(section).not.toContain(enMessages.market.overview.cautions);
  });

  it("falls back to the description when there is no overview", async () => {
    const section = overviewSection(await render())!;
    expect(section).not.toContain('data-testid="mcp-ai-overview"');
    expect(section).toContain(DESCRIPTION);
  });

  it("asks in the visitor's language and notes an English fallback", async () => {
    withOverview(overview({ locale: "en" }));
    const html = await render("zh-CN");
    expect(overviews.getPublicMcpAiOverview).toHaveBeenCalledWith(
      IDENTIFIER,
      "zh-CN",
    );
    const section = overviewSection(html)!;
    expect(section).toContain(zhCNMessages.mcp.aiOverview.title);
    expect(section).toContain(zhCNMessages.mcp.aiOverview.englishFallback);
  });

  it("shows no fallback note when the overview is in the visitor's language", async () => {
    withOverview(overview({ locale: "zh-CN", summary: "为出行查询天气。" }));
    const section = overviewSection(await render("zh-CN"))!;
    expect(section).toContain("为出行查询天气。");
    expect(section).not.toContain(zhCNMessages.mcp.aiOverview.englishFallback);
  });

  it("gives the overview its own section when the manifest has nothing else to say", async () => {
    market.getPublicMcpManifest.mockResolvedValue({
      ...manifestResponse,
      manifest: { ...manifestResponse.manifest, description: undefined },
    });
    let html = await render();
    expect(navLabels(html, "Sections")).not.toContain("overview");

    withOverview(overview());
    html = await render();
    expect(navLabels(html, "Sections")[0]).toBe("overview");
    const section = overviewSection(html)!;
    expect(section).toContain('data-testid="mcp-ai-overview"');
    // No empty description panel under it.
    expect(section).not.toContain("divide-y");
  });
});

describe("public MCP detail page hreflang", () => {
  async function metadata(locale: string) {
    return generateMetadata({
      params: Promise.resolve({
        identifier: encodeURIComponent(IDENTIFIER),
        locale,
      }),
    });
  }

  it("lists English and each language with a visible overview", async () => {
    overviews.getPublicMcpOverviewLocales.mockResolvedValue(["zh-CN"]);
    const english = await metadata("en");
    expect(overviews.getPublicMcpOverviewLocales).toHaveBeenCalledWith(
      IDENTIFIER,
    );
    expect(english.alternates).toEqual({
      canonical: `${SITE_URL}${PATH}`,
      languages: {
        en: `${SITE_URL}${PATH}`,
        "zh-CN": `${SITE_URL}/zh-CN${PATH}`,
        "x-default": `${SITE_URL}${PATH}`,
      },
    });
    expect(english.openGraph?.url).toBe(`${SITE_URL}${PATH}`);

    // A translated page is its own canonical; an untranslated one is a copy
    // of the English page.
    expect((await metadata("zh-CN")).alternates?.canonical).toBe(
      `${SITE_URL}/zh-CN${PATH}`,
    );
    expect((await metadata("zh-TW")).alternates).toMatchObject({
      canonical: `${SITE_URL}${PATH}`,
    });
  });

  it("keeps the canonical on English, with no alternates, without an overview in another language", async () => {
    overviews.getPublicMcpOverviewLocales.mockResolvedValue([]);
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      expect((await metadata(locale)).alternates).toEqual({
        canonical: `${SITE_URL}${PATH}`,
      });
    }
  });
});

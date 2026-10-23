import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MarketMcpReadme,
  type McpReadmeStatus,
  getMarketMcpManifestResponseSchema,
} from "@sourceweft/market-contracts";

const market = vi.hoisted(() => ({
  getPublicMcpDetail: vi.fn(),
  getPublicMcpManifest: vi.fn(),
  listPublicMcp: vi.fn(),
  listPublicMcpCategories: vi.fn(),
}));

vi.mock("../../../../lib/market-mcp", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
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
// suite is about the README around them.
vi.mock("../_components/mcp-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_components/mcp-display")>()),
  McpCardGrid: () => null,
  McpRuntimeBadge: () => null,
  McpToolRows: () => null,
  McpVerificationBadge: () => null,
}));
// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real English catalog directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    getTranslations: async (
      input?: string | { locale?: string; namespace?: string },
    ) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: (typeof input === "string"
          ? input
          : input?.namespace) as never,
      }),
    setRequestLocale: () => {},
  };
});
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

import PublicMcpDetailPage, { generateMetadata } from "./page";
import { mcpDetailSeoDescription } from "../_components/mcp-display";
import { SITE_URL } from "../../../seo";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const IDENTIFIER = "io.github.o/weather";

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
    endpointUrl: "https://weather.example/mcp",
    tools: [{ name: "forecast" }],
    transport: "streamable_http",
    version: "1.0.0",
  },
  version: {
    manifestJson: {},
    status: "published",
    version: "1.0.0",
  },
});

function readme(
  status: McpReadmeStatus,
  patch: Partial<MarketMcpReadme> = {},
): MarketMcpReadme {
  return {
    status,
    ...(status === "ok"
      ? {
          markdown:
            '# Weather MCP\n\n<p align="center"><img src="docs/logo.png" alt="Logo"></p>\n\nSee [the setup guide](docs/setup.md).\n\n<script>alert(1)</script>',
        }
      : {}),
    source: {
      blobUrl: `https://github.com/o/r/blob/${SHA}/mcp/README.md`,
      path: "mcp/README.md",
      rawUrl: `https://raw.githubusercontent.com/o/r/${SHA}/mcp/README.md`,
      ref: SHA,
      repoUrl: "https://github.com/o/r",
    },
    ...patch,
  };
}

async function render(locale = "en") {
  const element = await PublicMcpDetailPage({
    params: Promise.resolve({
      identifier: encodeURIComponent(IDENTIFIER),
      locale,
    }),
  });
  return renderToStaticMarkup(element);
}

function readmeSection(html: string) {
  return /<section[^>]*id="readme"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
}

function navLabels(html: string) {
  const nav = /<nav aria-label="Sections"[^>]*>([\s\S]*?)<\/nav>/.exec(
    html,
  )![1]!;
  return [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
}

beforeEach(() => {
  market.getPublicMcpManifest.mockReset().mockResolvedValue(manifestResponse);
  market.getPublicMcpDetail
    .mockReset()
    .mockResolvedValue({ readme: null, versions: [] });
  market.listPublicMcp.mockReset().mockResolvedValue({ items: [] });
  market.listPublicMcpCategories.mockReset().mockResolvedValue({ items: [] });
});

describe("public MCP detail page README", () => {
  it("shows the README after Installation, linked from the section nav", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: readme("ok"),
      versions: [],
    });
    const html = await render();
    expect(navLabels(html)).toEqual(["installation", "readme", "tools"]);
    expect(html).toMatch(/href="#readme"[^>]*>README</);
    expect(html.indexOf('id="installation"')).toBeLessThan(
      html.indexOf('id="readme"'),
    );
    expect(html.indexOf('id="readme"')).toBeLessThan(
      html.indexOf('id="tools"'),
    );

    const section = readmeSection(html)!;
    expect(section).toMatch(/<h2[^>]*>README<\/h2>/);
    // The README's own title sits under the page's headings.
    expect(section).toMatch(/<h2[^>]*>Weather MCP<\/h2>/);
    // Relative links resolve against the README's own address at its commit;
    // its picture is not loaded, only linked.
    expect(section).toContain(
      `href="https://github.com/o/r/blob/${SHA}/mcp/docs/setup.md"`,
    );
    expect(section).toContain(
      `href="https://raw.githubusercontent.com/o/r/${SHA}/mcp/docs/logo.png"`,
    );
    expect(section).not.toMatch(/<img/i);
    expect(section).not.toMatch(/<script/i);
    expect(section).toContain('<p align="center">');
    // Short: not folded.
    expect(section).not.toContain("Show full README");
    expect(section).toMatch(
      new RegExp(
        `Source: <a [^>]*href="https://github\\.com/o/r/blob/${SHA}/mcp/README\\.md"[^>]*>mcp/README\\.md</a> at commit <code[^>]*>0123456</code>`,
      ),
    );
    expect(section).not.toContain("Read the README in its repository");
  });

  it("folds a long README behind an accessible control", async () => {
    const markdown = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index + 1}.\n`,
    ).join("\n");
    market.getPublicMcpDetail.mockResolvedValue({
      readme: readme("ok", { markdown }),
      versions: [],
    });
    const section = readmeSection(await render())!;
    const regionId = /<div [^>]*data-state="collapsed"[^>]*id="([^"]+)"/.exec(
      section,
    )?.[1];
    expect(regionId).toBeTruthy();
    expect(section).toMatch(
      new RegExp(
        `<button [^>]*aria-controls="${regionId}"[^>]*aria-expanded="false"[^>]*>Show full README`,
      ),
    );
    expect(section).toContain("max-h-[75svh]");
    // Folded, not cut: the whole README is in the page.
    expect(section).toContain("Paragraph 40.");
    expect(section).toContain("Source: ");
  });

  it("says when the repository has no README", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: readme("not_found", { source: null }),
      versions: [],
    });
    const html = await render();
    expect(navLabels(html)).toContain("readme");
    const section = readmeSection(html)!;
    expect(section).toContain("This repository has no README.");
    expect(section).not.toContain("Source: ");
    expect(section).not.toContain("Show full README");
  });

  it("links a README too large to show to its page", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: readme("too_large"),
      versions: [],
    });
    const section = readmeSection(await render())!;
    expect(section).toMatch(
      new RegExp(
        `The README is too large to show here — <a [^>]*href="https://github\\.com/o/r/blob/${SHA}/mcp/README\\.md"[^>]*>open it on GitHub</a>`,
      ),
    );
    expect(section).not.toContain("Source: ");
  });

  it("offers the repository when the README could not be read", async () => {
    for (const status of [
      "error",
      "unsupported_host",
    ] satisfies McpReadmeStatus[]) {
      market.getPublicMcpDetail.mockResolvedValue({
        readme: readme(status),
        versions: [],
      });
      const html = await render();
      expect(navLabels(html)).toContain("readme");
      const section = readmeSection(html)!;
      expect(section).toMatch(
        /<a [^>]*href="https:\/\/github\.com\/o\/r"[^>]*rel="nofollow ugc noopener noreferrer"[^>]*target="_blank"[^>]*>Read the README in its repository/,
      );
      expect(section).not.toContain("Source: ");
      expect(section).not.toContain("no README");
    }
  });

  it("shows no README section while pending, without a README, or with nowhere to send the reader", async () => {
    for (const value of [
      readme("pending"),
      null,
      readme("error", { source: null }),
      readme("unsupported_host", { source: null }),
    ]) {
      market.getPublicMcpDetail.mockResolvedValue({
        readme: value,
        versions: [],
      });
      const html = await render();
      expect(html).not.toContain('id="readme"');
      expect(navLabels(html)).toEqual(["installation", "tools"]);
    }
  });
});

describe("public MCP detail page Auth field", () => {
  function authField(html: string) {
    return html.match(/<dt[^>]*>Auth<\/dt><dd[^>]*>([^<]*)<\/dd>/)?.[1];
  }

  // The second description under the Auth term: what the label means.
  function authExplanation(html: string) {
    return html.match(
      /<dt[^>]*>Auth<\/dt><dd[^>]*>[^<]*<\/dd><dd[^>]*>([^<]*)<\/dd>/,
    )?.[1];
  }

  function withAuth(auth: Record<string, unknown>) {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        manifest: { ...manifestResponse.manifest, auth },
      }),
    );
  }

  it("says an open server needs no authentication", async () => {
    const html = await render();
    expect(authField(html)).toBe("Not required");
    expect(authExplanation(html)).toBe("Connects without a credential.");
  });

  // Issue #337: an open server that takes an optional key header (Exa-like).
  it("names an optional API key and the header it goes in", async () => {
    withAuth({
      type: "none",
      required: false,
      posture: "optional",
      methods: [
        {
          type: "header",
          name: "x-api-key",
          description: "Exa API key for higher rate limits",
        },
      ],
    });
    const html = await render();
    expect(authField(html)).toBe("Not required · optional API key");
    expect(authExplanation(html)).toBe(
      "Connects without a credential; you can add an API key in the x-api-key header.",
    );
  });

  it("explains a key header and an OAuth sign-in", async () => {
    withAuth({
      type: "bearer",
      required: true,
      headerName: "Authorization",
      allowedHeaderNames: ["Authorization"],
    });
    expect(authExplanation(await render())).toBe(
      "Send an API key in the Authorization header.",
    );
    withAuth({ type: "oauth", required: true });
    expect(authExplanation(await render())).toBe(
      "Sign in with OAuth when you connect.",
    );
  });

  // Issue #337: OAuth sign-in, or the account key in the Authorization header.
  it("names OAuth or an API key for an OAuth server that takes a key header", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: { ...manifestResponse.item, requiresAuth: true },
        manifest: {
          ...manifestResponse.manifest,
          auth: {
            type: "oauth",
            required: true,
            headerName: "Authorization",
            allowedHeaderNames: ["Authorization"],
          },
        },
      }),
    );
    const html = await render();
    expect(authField(html)).toBe("OAuth or API key");
    expect(authExplanation(html)).toBe(
      "Sign in with OAuth, or send an API key in the Authorization header.",
    );
    // Installation then asks for the credential and notes the OAuth sign-in.
    expect(html).toContain("Connect the required credentials.");
    expect(html).toContain(
      "The client completes OAuth sign-in on first connect.",
    );
  });
});

describe("public MCP detail page security note", () => {
  it("keeps its heading on its own line above its text", async () => {
    const html = await render();
    expect(html).toMatch(
      /<div class="(?:[^"]* )?flex(?: [^"]*)?"><svg[\s\S]*?<\/svg>Security note<\/div><p>MCP servers receive tool arguments/,
    );
  });
});

describe("public MCP detail page README badge", () => {
  // As React writes it into the page's text.
  const markdown = `[![Listed on SourceWeft](${SITE_URL}/badge/mcp/io.github.o%2Fweather.svg)](${SITE_URL}/mcp/io.github.o%2Fweather?utm_source=readme&amp;utm_medium=badge)`;

  it("offers every visitor the badge, folded, in the details rail under the security note", async () => {
    const html = await render();
    const badge =
      /<details[^>]*data-testid="catalog-badge"[^>]*>([\s\S]*?)<\/details>/.exec(
        html,
      );
    expect(badge?.[0]).not.toMatch(/<details[^>]*\bopen\b/);
    expect(badge?.[1]).toContain("Add a badge to your README");
    expect(badge?.[1]).toContain(
      `src="${SITE_URL}/badge/mcp/io.github.o%2Fweather.svg"`,
    );
    expect(badge?.[1]).toContain(markdown);
    expect(html.indexOf("Security note")).toBeLessThan(badge!.index);
  });

  it("links a Chinese page's snippet to the canonical English page", async () => {
    const html = await render("zh-CN");
    expect(html).toContain(markdown);
    expect(html).not.toMatch(/\/zh-CN\/(?:badge|mcp)\//);
  });
});

describe("a server whose README many servers show", () => {
  it.each(["en", "zh-CN", "zh-TW"])(
    "stays out of search but keeps its links followed and its own canonical (%s)",
    async (locale) => {
      market.getPublicMcpManifest.mockResolvedValue(manifestResponse);
      market.getPublicMcpDetail.mockResolvedValue({
        readme: null,
        versions: [],
        overviewLocales: ["en", "zh-CN", "zh-TW"],
        searchIndexable: false,
      });
      const actual = await generateMetadata({
        params: Promise.resolve({
          identifier: encodeURIComponent(IDENTIFIER),
          locale,
        }),
      });
      expect(actual.robots).toEqual({ follow: true, index: false });
      expect(actual.alternates?.canonical).toBe(
        `${SITE_URL}${locale === "en" ? "" : `/${locale}`}/mcp/${encodeURIComponent(IDENTIFIER)}`,
      );
    },
  );

  it("is indexed when the market says it may be", async () => {
    market.getPublicMcpManifest.mockResolvedValue(manifestResponse);
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      versions: [],
      overviewLocales: [],
      searchIndexable: true,
    });
    const actual = await generateMetadata({
      params: Promise.resolve({
        identifier: encodeURIComponent(IDENTIFIER),
        locale: "en",
      }),
    });
    expect(actual.robots).toBeUndefined();
  });
});

describe("Lupa English search description experiment", () => {
  const lupaIdentifier = "io.github.paeyoungpark-web/lupa-mcp";
  const searchDescription =
    "Lupa MCP lets AI assistants search local Mac files and read indexed document text. Supports PDF, Office and HWP/HWPX files. Requires the Lupa macOS app.";

  function useManifest(identifier: string) {
    const result = {
      ...manifestResponse,
      item: { ...manifestResponse.item, identifier },
      manifest: { ...manifestResponse.manifest, identifier },
    };
    market.getPublicMcpManifest.mockResolvedValue(result);
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      versions: [],
      overviewLocales: ["en", "zh-CN", "zh-TW"],
    });
    return result;
  }

  function metadata(identifier: string, locale: string) {
    return generateMetadata({
      params: Promise.resolve({
        identifier: encodeURIComponent(identifier),
        locale,
      }),
    });
  }

  it("changes only the search description for the exact English page", async () => {
    const result = useManifest(lupaIdentifier);
    const originalDescription = mcpDetailSeoDescription(result);
    const actual = await metadata(lupaIdentifier, "en");
    expect(actual.description).toBe(searchDescription);
    // The invalid-locale metadata path resolves to English but is outside the
    // experiment, giving the unchanged metadata for this same manifest.
    const original = await metadata(lupaIdentifier, "invalid-locale");
    expect(actual).toEqual({ ...original, description: searchDescription });
    expect(actual.title).toBe("Weather MCP Server");
    expect(actual.alternates?.canonical).toBe(
      `${SITE_URL}/mcp/${encodeURIComponent(lupaIdentifier)}`,
    );
    expect(actual.robots).toBeUndefined();
    expect(actual.openGraph?.description).toBe(originalDescription);
    expect(actual.twitter?.description).toBe(originalDescription);
    expect(market.getPublicMcpManifest).toHaveBeenCalledWith(lupaIdentifier);
  });

  it.each(["zh-CN", "zh-TW", "ja", "invalid-locale"])(
    "keeps the original description for locale %s",
    async (locale) => {
      const result = useManifest(lupaIdentifier);
      expect((await metadata(lupaIdentifier, locale)).description).toBe(
        mcpDetailSeoDescription(result),
      );
    },
  );

  it.each([
    "io.github.mehmetnadir/cdpilot",
    "com.minaxlab/mina-labs",
    "io.github.paeyoungpark-web/lupa-mcp-extra",
    "io.github.someone-else/lupa-mcp",
  ])("keeps the original description for %s", async (identifier) => {
    const result = useManifest(identifier);
    const actual = await metadata(identifier, "en");
    const originalDescription = mcpDetailSeoDescription(result);
    expect(actual.description).toBe(originalDescription);
    expect(actual.openGraph?.description).toBe(originalDescription);
    expect(actual.twitter?.description).toBe(originalDescription);
  });

  it("does not override a different manifest returned for the Lupa request", async () => {
    const result = useManifest(IDENTIFIER);
    expect((await metadata(lupaIdentifier, "en")).description).toBe(
      mcpDetailSeoDescription(result),
    );
  });
});

// Issue #367 W1: the endpoint's own documentation link, from the RFC 9728
// protected-resource metadata federation kept in the version's provenance.
describe("public MCP detail page documentation link", () => {
  function withProvenance(provenanceJson: Record<string, unknown>) {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        version: { ...manifestResponse.version, provenanceJson },
      }),
    );
  }

  it("links the documentation the server's auth metadata names", async () => {
    withProvenance({
      authProbe: { result: "oauth" },
      authMetadata: {
        resourceName: "Weather MCP",
        resourceDocumentation: "https://docs.weather.example/mcp",
      },
    });
    const html = await render();
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/docs\.weather\.example\/mcp"[^>]*rel="noreferrer"[^>]*target="_blank"[^>]*>Documentation/,
    );
    // Listed with the server's other links, and as one of its addresses.
    expect(html.indexOf(">Homepage<")).toBeLessThan(0);
    expect(html.indexOf(">Documentation<")).toBeLessThan(
      html.indexOf(">Repository<"),
    );
    expect(html).toContain(
      '"sameAs":["https://github.com/o/r","https://docs.weather.example/mcp"]',
    );
  });

  it("shows no documentation link without one, or with one that is not https", async () => {
    for (const provenanceJson of [
      {},
      { authMetadata: { resourceName: "Weather MCP" } },
      {
        authMetadata: { resourceDocumentation: "http://docs.weather.example" },
      },
      { authMetadata: { resourceDocumentation: "not a url" } },
      { authMetadata: "https://docs.weather.example/mcp" },
    ]) {
      withProvenance(provenanceJson);
      const html = await render();
      expect(html).not.toContain(">Documentation<");
      expect(html).not.toContain("docs.weather.example");
    }
  });
});

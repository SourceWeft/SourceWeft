import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketMcpManifestResponseSchema } from "@sourceweft/market-contracts";

import type { McpReadmePayload, McpReadmeStatus } from "@/lib/mcp-readme";

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

import PublicMcpDetailPage from "./page";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const IDENTIFIER = "io.github.o/weather";

const manifestResponse = getMarketMcpManifestResponseSchema.parse({
  item: {
    createdAt: "2026-09-01T00:00:00.000Z",
    id: "mcp-1",
    identifier: IDENTIFIER,
    kind: "mcp",
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
  patch: Partial<McpReadmePayload> = {},
): McpReadmePayload {
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

async function render() {
  const element = await PublicMcpDetailPage({
    params: Promise.resolve({
      identifier: encodeURIComponent(IDENTIFIER),
      locale: "en",
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

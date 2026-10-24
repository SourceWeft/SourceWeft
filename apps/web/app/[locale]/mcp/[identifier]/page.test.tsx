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
  McpCardGrid: vi.fn(() => null),
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

import PublicMcpDetailPage, {
  generateMetadata,
  productBrandLabel,
} from "./page";
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
    expect(navLabels(html)).toEqual([
      "overview",
      "installation",
      "readme",
      "tools",
    ]);
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
      expect(navLabels(html)).toEqual(["overview", "installation", "tools"]);
    }
  });
});

// Issue #367 W8: the servers integrating the same product.
describe("public MCP detail page product group", () => {
  const OFFICIAL = "com.notion/mcp";
  function member(
    identifier: string,
    name: string,
    patch: Record<string, unknown> = {},
  ) {
    return {
      ...manifestResponse.item,
      categories: [],
      id: `id-${identifier}`,
      identifier,
      name,
      publisherMatch: false,
      toolsCount: 3,
      ...patch,
    };
  }
  const group = {
    domain: "notion.com",
    brand: "notion",
    officialIdentifier: OFFICIAL,
    members: [
      member(OFFICIAL, "Notion", { publisherMatch: true, toolsCount: 19 }),
      member(IDENTIFIER, "Weather"),
      member("io.github.a/better-notion", "Better Notion"),
      member("io.github.b/notion-mcp", "Notion Mcp"),
    ],
  };
  function withDetail(relatedProduct: unknown) {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      relatedProduct,
      versions: [],
    });
  }
  function integrationsSection(html: string) {
    return /<section[^>]*id="integrations"[^>]*>([\s\S]*?)<\/section>/.exec(
      html,
    )?.[1];
  }

  it("lists the other members on a member's page and points to the publisher's own server", async () => {
    withDetail(group);
    const html = await render();
    expect(navLabels(html)).toEqual([
      "overview",
      "installation",
      "tools",
      "integrations",
    ]);
    // No count: the market loaded part of the group, not a known total.
    expect(html).toMatch(/href="#integrations"[^>]*>Notion integrations</);
    const section = integrationsSection(html)!;
    expect(section).toMatch(/<h2[^>]*>Other Notion integrations<\/h2>/);
    expect(section).not.toMatch(/<span[^>]*>\d+<\/span>/);
    // The cards are the shared card grid (mocked here), fed every member but
    // this page's own server, the product's own first. Five show at first,
    // the rest behind "Show more", and no card repeats the verification badge.
    const grid = vi.mocked(
      (await import("../_components/mcp-display")).McpCardGrid,
    );
    const call = grid.mock.calls.at(-1)![0] as {
      hideVerification?: boolean;
      initialCount?: number;
      items: { identifier: string }[];
      showMoreLabel?: string;
    };
    expect(call.initialCount).toBe(5);
    expect(call.showMoreLabel).toBe("Show more");
    expect(call.hideVerification).toBe(true);
    expect(call.items.map((entry) => entry.identifier)).toEqual([
      OFFICIAL,
      "io.github.a/better-notion",
      "io.github.b/notion-mcp",
    ]);
    // One line under the summary names the official server and links its page.
    expect(html).toMatch(
      new RegExp(
        `<p [^>]*data-official-pointer="${OFFICIAL}"[^>]*>The publisher(?:'|’|&#x27;)s own server: <a [^>]*href="/mcp/${encodeURIComponent(OFFICIAL)}"[^>]*>Notion</a></p>`,
      ),
    );
    expect(html.indexOf('id="tools"')).toBeLessThan(
      html.indexOf('id="integrations"'),
    );
  });

  it("puts the product's own server first whatever the market's order", async () => {
    withDetail({
      ...group,
      members: [
        member("io.github.a/better-notion", "Better Notion"),
        member(IDENTIFIER, "Weather"),
        member(OFFICIAL, "Notion", { publisherMatch: true }),
        member("io.github.b/notion-mcp", "Notion Mcp"),
      ],
    });
    await render();
    const grid = vi.mocked(
      (await import("../_components/mcp-display")).McpCardGrid,
    );
    const call = grid.mock.calls.at(-1)![0] as {
      items: { identifier: string }[];
    };
    expect(call.items.map((entry) => entry.identifier)).toEqual([
      OFFICIAL,
      "io.github.a/better-notion",
      "io.github.b/notion-mcp",
    ]);
  });

  it("shows no pointer on the publisher's own page, and the section does not count the rest", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: {
          ...manifestResponse.item,
          identifier: OFFICIAL,
          name: "Notion",
        },
        manifest: {
          ...manifestResponse.manifest,
          identifier: OFFICIAL,
          name: "Notion",
        },
      }),
    );
    withDetail(group);
    const element = await PublicMcpDetailPage({
      params: Promise.resolve({
        identifier: encodeURIComponent(OFFICIAL),
        locale: "en",
      }),
    });
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("data-official-pointer");
    expect(html).toMatch(/href="#integrations"[^>]*>Notion integrations</);
    expect(integrationsSection(html)).not.toMatch(/<span[^>]*>\d+<\/span>/);
  });

  it("shows nothing of a group with no other member, or without a group", async () => {
    for (const relatedProduct of [
      null,
      undefined,
      { ...group, members: [member(IDENTIFIER, "Weather")] },
    ]) {
      withDetail(relatedProduct);
      const html = await render();
      expect(html).not.toContain('id="integrations"');
      expect(html).not.toContain("data-official-pointer");
      expect(navLabels(html)).toEqual(["overview", "installation", "tools"]);
    }
    // The only other member being the publisher's own server: it is listed,
    // and the pointer names it too.
    withDetail({
      ...group,
      members: [
        member(OFFICIAL, "Notion", { publisherMatch: true }),
        member(IDENTIFIER, "Weather"),
      ],
    });
    const html = await render();
    expect(html).toContain(`data-official-pointer="${OFFICIAL}"`);
    expect(html).toMatch(/href="#integrations"[^>]*>Notion integrations</);
  });

  it("writes the brand as a heading word", () => {
    expect(productBrandLabel("notion")).toBe("Notion");
    expect(productBrandLabel("claw-link")).toBe("Claw-Link");
    expect(productBrandLabel("")).toBe("");
  });
});

describe("public MCP detail page publisher", () => {
  function header(html: string) {
    return /<h1[\s\S]*?<\/h1>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  }

  // Issue #367: the registry-verified domain next to the provider name.
  it("says who published the server, from its registry namespace", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: {
          ...manifestResponse.item,
          identifier: "com.notion/mcp",
          providerName: "com.notion",
          publisher: {
            domain: "notion.com",
            source: "registry-namespace",
            endpointMatch: true,
          },
        },
      }),
    );
    const line = header(await render());
    expect(line).toContain(">com.notion</span>");
    expect(line).toContain(
      '<span data-publisher-domain="notion.com">Published by notion.com</span>',
    );
    expect(line.indexOf("com.notion</span>")).toBeLessThan(
      line.indexOf("Published by"),
    );
  });

  // An io.github.* namespace names a GitHub account the registry checked,
  // not the product's maker: a neutral label, never "Official publisher".
  it("labels a GitHub-namespace server with its GitHub account, neutrally", async () => {
    const html = await render();
    expect(html).toContain(
      '<span data-github-account="o">Published by GitHub account o</span>',
    );
    expect(html).not.toContain("data-publisher-domain");
    expect(html).not.toContain("Official publisher");
  });

  it("marks only a domain publisher that also runs the endpoint as official", async () => {
    const publisherPage = (endpointMatch: boolean, patch = {}) => {
      market.getPublicMcpManifest.mockResolvedValue(
        getMarketMcpManifestResponseSchema.parse({
          ...manifestResponse,
          item: {
            ...manifestResponse.item,
            identifier: "com.notion/mcp",
            publisher: {
              domain: "notion.com",
              source: "registry-namespace",
              endpointMatch,
            },
            ...patch,
          },
        }),
      );
      return render();
    };
    expect(await publisherPage(true)).toContain("data-official-publisher");
    expect(await publisherPage(false)).not.toContain(
      "data-official-publisher",
    );
  });

  it("does not make a claimed third-party GitHub listing official", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: { ...manifestResponse.item, claimed: true },
      }),
    );
    const html = await render();
    expect(html).toContain("Claimed by owner");
    expect(html).toContain("Published by GitHub account o");
    expect(html).not.toContain("Official publisher");
    expect(html).not.toContain("data-official-publisher");
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
      /<div class="(?:[^"]* )?flex(?: [^"]*)?"><svg[\s\S]*?<\/svg>Security note<\/div><div class="space-y-2"><p>MCP servers receive tool/,
    );
  });

  function securityNote(html: string) {
    return /Security note<\/div>([\s\S]*?)<\/section>/
      .exec(html)![1]!
      .replaceAll("&#x27;", "'");
  }

  it("says where the publisher claim comes from and never calls a listing safe", async () => {
    // A GitHub-namespace listing: a checked account, not a verified maker.
    const github = securityNote(await render());
    expect(github).toContain("verified the GitHub account o for this listing");
    expect(github).toContain("does not show the account is the product");
    // A domain publisher that runs the endpoint.
    const withPublisher = (endpointMatch: boolean) => {
      market.getPublicMcpManifest.mockResolvedValue(
        getMarketMcpManifestResponseSchema.parse({
          ...manifestResponse,
          item: {
            ...manifestResponse.item,
            identifier: "com.notion/mcp",
            publisher: {
              domain: "notion.com",
              source: "registry-namespace",
              endpointMatch,
            },
            verified: true,
          },
        }),
      );
      return render();
    };
    const matched = securityNote(await withPublisher(true));
    expect(matched).toContain("namespace belongs to notion.com");
    expect(matched).toContain("does not make the server's tools safe");
    const mismatched = securityNote(await withPublisher(false));
    expect(mismatched).toContain("endpoint is not on that domain");
    // No domain, no GitHub namespace: nothing was verified.
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: { ...manifestResponse.item, identifier: "someone/else" },
      }),
    );
    expect(securityNote(await render())).toContain(
      "has not verified who publishes this server",
    );
    for (const note of [github, matched, mismatched]) {
      expect(note).not.toContain("is safe");
      expect(note).not.toContain("Unverified listings are allowed");
      expect(note).toContain("do not review the server's code");
    }
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
  // Without an AI overview the description is the template sentence (#367
  // W4); the fixture's registry summary is shorter than it.
  const templateDescription =
    "Weather's hosted MCP server (weather.example); no sign-in required; Streamable HTTP; 1 tool.";

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
    useManifest(lupaIdentifier);
    const originalDescription = templateDescription;
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
      useManifest(lupaIdentifier);
      const description = (await metadata(lupaIdentifier, locale)).description;
      expect(description).not.toBe(searchDescription);
      expect(description).toMatch(/^Weather/);
    },
  );

  it.each([
    "io.github.mehmetnadir/cdpilot",
    "com.minaxlab/mina-labs",
    "io.github.paeyoungpark-web/lupa-mcp-extra",
    "io.github.someone-else/lupa-mcp",
  ])("keeps the original description for %s", async (identifier) => {
    useManifest(identifier);
    const actual = await metadata(identifier, "en");
    expect(actual.description).toBe(templateDescription);
    expect(actual.openGraph?.description).toBe(templateDescription);
    expect(actual.twitter?.description).toBe(templateDescription);
  });

  it("does not override a different manifest returned for the Lupa request", async () => {
    useManifest(IDENTIFIER);
    expect((await metadata(lupaIdentifier, "en")).description).toBe(
      templateDescription,
    );
  });
});

// Issue #367 W1: the endpoint's own documentation link, from the RFC 9728
// protected-resource metadata federation kept in the version's provenance.
// The facts panel (W4) shows it; the page lists it as one of the server's
// addresses.
describe("public MCP detail page documentation link", () => {
  function withProvenance(provenanceJson: Record<string, unknown>) {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        version: { ...manifestResponse.version, provenanceJson },
      }),
    );
  }

  it("links the documentation the server's auth metadata names, once", async () => {
    withProvenance({
      authProbe: { result: "oauth" },
      authMetadata: {
        resourceName: "Weather MCP",
        resourceDocumentation: "https://docs.weather.example/mcp",
      },
    });
    const html = await render();
    const links = html.match(
      /<a [^>]*href="https:\/\/docs\.weather\.example\/mcp"[^>]*>/g,
    );
    expect(links).toHaveLength(1);
    expect(links![0]).toMatch(/rel="nofollow noopener noreferrer"/);
    expect(links![0]).toMatch(/target="_blank"/);
    expect(html).toMatch(/<dt[^>]*>Documentation<\/dt>/);
    expect(html).toContain(
      '"sameAs":["https://github.com/o/r","https://docs.weather.example/mcp"]',
    );
  });

  it("shows no documentation link without one, or with one that is not a URL", async () => {
    for (const provenanceJson of [
      {},
      { authMetadata: { resourceName: "Weather MCP" } },
      { authMetadata: { resourceDocumentation: "not a url" } },
      { authMetadata: { resourceDocumentation: "javascript:alert(1)" } },
      { authMetadata: "https://docs.weather.example/mcp" },
    ]) {
      withProvenance(provenanceJson);
      const html = await render();
      expect(html).not.toMatch(/<dt[^>]*>Documentation<\/dt>/);
      expect(html).not.toContain("docs.weather.example");
      expect(html).not.toContain("alert(1)");
    }
  });
});

describe("public MCP detail page structured data", () => {
  function softwareApplication(html: string) {
    return [
      ...html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
      ),
    ]
      .map((match) => JSON.parse(match[1]!) as Record<string, unknown>)
      .find((data) => data["@type"] === "SoftwareApplication")!;
  }

  it("lists the server's tools as the application's features", async () => {
    const html = await render();
    expect(softwareApplication(html).featureList).toEqual(["forecast"]);
  });

  it("caps the features at 50 tools and leaves them out without tools", async () => {
    market.getPublicMcpManifest.mockResolvedValue({
      ...manifestResponse,
      manifest: {
        ...manifestResponse.manifest,
        tools: Array.from({ length: 60 }, (_, index) => ({
          ...manifestResponse.manifest.tools[0]!,
          name: `tool_${index}`,
        })),
      },
    });
    const many = softwareApplication(await render()).featureList as string[];
    expect(many).toHaveLength(50);
    expect(many[49]).toBe("tool_49");

    market.getPublicMcpManifest.mockResolvedValue({
      ...manifestResponse,
      manifest: { ...manifestResponse.manifest, tools: [] },
    });
    expect(softwareApplication(await render())).not.toHaveProperty(
      "featureList",
    );
  });
});

describe("public MCP detail page Score section", () => {
  type ScoreItem = {
    key: string;
    weight: number;
    applicable: boolean;
    required: boolean;
    met: boolean;
  };
  const ITEMS: Array<[string, number, boolean]> = [
    ["reachable", 25, true],
    ["authDeclared", 10, true],
    ["hasTools", 15, false],
    ["hasDescription", 15, true],
    ["hasLogo", 10, false],
    ["hasDocs", 15, false],
    ["hasLicense", 10, false],
  ];
  function score(
    grade: "A" | "B" | "F",
    met: string[],
    notApplicable: string[] = [],
  ): {
    grade: "A" | "B" | "F";
    percentage: number;
    items: ScoreItem[];
  } {
    const items = ITEMS.map(([key, weight, required]) => ({
      key,
      weight,
      applicable: !notApplicable.includes(key),
      required,
      met: met.includes(key),
    }));
    const applicable = items.reduce(
      (sum, item) => sum + (item.applicable ? item.weight : 0),
      0,
    );
    const earned = items.reduce(
      (sum, item) => sum + (item.met ? item.weight : 0),
      0,
    );
    return {
      grade,
      items,
      percentage: Math.round((earned / applicable) * 100),
    };
  }
  function scoreSection(html: string) {
    return /<section[^>]*id="score"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
  }
  function itemRow(section: string, key: string) {
    return new RegExp(
      `<li[^>]*data-score-item="${key}"[^>]*>[\\s\\S]*?</li>`,
    ).exec(section)?.[0];
  }

  it("shows the percentage and a checklist with every item met and no hints, after the versions", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      score: score("A", [
        "reachable",
        "authDeclared",
        "hasTools",
        "hasDescription",
        "hasLogo",
        "hasDocs",
        "hasLicense",
      ]),
      versions: [
        {
          manifestJson: {},
          provenanceJson: {},
          publishedAt: null,
          status: "published",
          version: "1.0.0",
        },
      ],
    });
    const html = await render();
    expect(navLabels(html)).toEqual([
      "overview",
      "installation",
      "tools",
      "versions",
      "score",
    ]);
    expect(html).toMatch(/href="#score"[^>]*>Score</);
    expect(html.indexOf('id="versions"')).toBeLessThan(
      html.indexOf('id="score"'),
    );
    const section = scoreSection(html)!;
    expect(section).toMatch(/<h2[^>]*>Score<\/h2>/);
    expect(section).toContain("100% of the applicable checks met");
    // Seven rows, all met, so none carries a hint.
    expect([...section.matchAll(/data-score-item="/g)]).toHaveLength(7);
    expect([...section.matchAll(/data-score-met="true"/g)]).toHaveLength(7);
    expect(itemRow(section, "reachable")).toContain("Reached in the last 30 days");
    expect(itemRow(section, "reachable")).toContain("Required");
    expect(itemRow(section, "reachable")).toContain("25 pts");
    expect(itemRow(section, "reachable")).not.toContain("SourceWeft probes");
    expect(itemRow(section, "hasLogo")).not.toContain("Required");
    // Identity is a badge, not a point.
    expect(section).not.toContain("Official publisher");
    expect(section).not.toContain("Claimed by owner");
  });

  it("shows no letter grade and no text derived from one", async () => {
    for (const grade of ["A", "B", "F"] as const) {
      market.getPublicMcpDetail.mockResolvedValue({
        readme: null,
        score: score(grade, ["reachable", "authDeclared", "hasDescription"]),
        versions: [],
      });
      const section = scoreSection(await render())!;
      expect(section).not.toContain("data-score-grade");
      expect(section).not.toMatch(/aria-label="Grade/);
      expect(section).not.toMatch(
        /Complete listing|Good listing|Incomplete listing/,
      );
    }
  });

  it("shows the unmet items' hints", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      score: score("B", [
        "reachable",
        "authDeclared",
        "hasDescription",
        "hasDocs",
      ]),
      versions: [],
    });
    const section = scoreSection(await render())!;
    expect(section).toContain("65% of the applicable checks met");
    expect(itemRow(section, "hasTools")).toContain(
      "Answer tools/list without a credential",
    );
    expect(itemRow(section, "hasLogo")).toContain("Publish an icon");
    expect(itemRow(section, "hasLicense")).toContain("Declare a license");
    expect(itemRow(section, "hasDocs")).not.toContain("README");
  });

  it("marks the failed required item", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      score: score("F", ["reachable", "authDeclared", "hasLogo"]),
      versions: [],
    });
    const section = scoreSection(await render())!;
    expect(section).toContain("45% of the applicable checks met");
    const description = itemRow(section, "hasDescription")!;
    expect(description).toContain('data-score-met="false"');
    expect(description).toContain("Required");
    expect(description).toContain("at least 40 characters");
  });

  it("leaves an item that does not apply out of the percentage and says so", async () => {
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      score: score(
        "B",
        ["reachable", "authDeclared", "hasDescription", "hasLogo"],
        ["hasLicense"],
      ),
      versions: [],
    });
    const section = scoreSection(await render())!;
    // 60 of the 90 that apply.
    expect(section).toContain("67% of the applicable checks met");
    const license = itemRow(section, "hasLicense")!;
    expect(license).toContain('data-score-applicable="false"');
    expect(license).toContain("Not applicable");
    expect(license).toContain("no license is expected here");
    expect(license).not.toContain("10 pts");
    expect(license).not.toContain("Declare a license");
  });

  it("shows no Score section when the market has no score", async () => {
    const html = await render();
    expect(scoreSection(html)).toBeUndefined();
    expect(navLabels(html)).not.toContain("score");
  });
});

// Issue #367 A1: what the top card says about tools, license and language.
describe("public MCP detail page top card", () => {
  function topCard(html: string) {
    return /<dl class="grid grid-cols-2[\s\S]*?<\/dl>/.exec(html)![0];
  }
  function use(patch: {
    item?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    provenanceJson?: Record<string, unknown>;
    score?: unknown;
  }) {
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: { ...manifestResponse.item, ...patch.item },
        manifest: { ...manifestResponse.manifest, ...patch.manifest },
        version: {
          ...manifestResponse.version,
          provenanceJson: patch.provenanceJson ?? {},
        },
      }),
    );
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      score: patch.score,
      versions: [],
    });
  }

  it("never says 0 tools for a server that asks for credentials", async () => {
    use({
      manifest: { tools: [] },
      provenanceJson: { authProbe: { result: "oauth" } },
    });
    const card = topCard(await render());
    expect(card).toContain("Sign-in required");
    expect(card).toContain("could not read its tools anonymously");
    // Signing in is not promised to reveal them.
    expect(card).toContain("may show tools");
    expect(card).not.toMatch(/<dd[^>]*>0<\/dd>/);
  });

  it("separates tools not indexed, read and empty, not validated and failed", async () => {
    use({ manifest: { tools: [] }, provenanceJson: { authProbe: { result: "open" } } });
    expect(topCard(await render())).toContain("Not indexed yet");
    use({
      manifest: { tools: [] },
      provenanceJson: {
        authProbe: { result: "open" },
        toolsListing: { listedAt: "2026-10-20T00:00:00.000Z", toolsCount: 0 },
      },
    });
    expect(topCard(await render())).toContain("No tools");
    use({ manifest: { tools: [], transport: "stdio" } });
    expect(topCard(await render())).toContain("Not validated yet");
    use({
      manifest: { tools: [], transport: "stdio" },
      item: {
        toolsValidation: {
          at: "2026-10-20T00:00:00.000Z",
          reason: "start",
          status: "failed",
        },
      },
    });
    const failed = topCard(await render());
    expect(failed).toContain("Not validated · the server did not start");
    expect(failed).toContain("the server did not start");
  });

  it("shows the tool count when there are tools", async () => {
    use({});
    expect(topCard(await render())).toMatch(/<dt[^>]*>Tools<\/dt><dd[^>]*>1<\/dd>/);
  });

  it("hides an unknown license and language instead of printing Unknown", async () => {
    use({});
    const card = topCard(await render());
    expect(card).not.toContain("License");
    expect(card).not.toContain("Language");
    expect(card).not.toContain("Unknown");
    use({ item: { language: "TypeScript", license: "MIT" } });
    const known = topCard(await render());
    expect(known).toMatch(/<dt[^>]*>License<\/dt><dd[^>]*>MIT<\/dd>/);
    expect(known).toMatch(/<dt[^>]*>Language<\/dt><dd[^>]*>TypeScript<\/dd>/);
  });

  it("calls a hosted-only service a hosted service, without license or language rows", async () => {
    use({
      item: { language: "TypeScript", license: "MIT" },
      score: {
        grade: "B",
        percentage: 67,
        items: [
          { key: "hasLicense", weight: 10, applicable: false, required: false, met: false },
        ],
      },
    });
    const card = topCard(await render());
    expect(card).toMatch(/<dt[^>]*>Delivery<\/dt><dd[^>]*>Hosted service<\/dd>/);
    expect(card).not.toContain("License");
    expect(card).not.toContain("Language");
  });
});

// Issue #367 A1: "More servers like X".
describe("public MCP detail page related servers", () => {
  function candidate(identifier: string, name: string, summary: string) {
    return {
      ...manifestResponse.item,
      categories: ["x"],
      identifier,
      name,
      summary,
    };
  }
  const withCategory = () =>
    market.getPublicMcpManifest.mockResolvedValue(
      getMarketMcpManifestResponseSchema.parse({
        ...manifestResponse,
        item: {
          ...manifestResponse.item,
          categories: ["x"],
          summary: "Forecasts for any city, with hourly weather detail.",
        },
      }),
    );

  it("keeps servers that share meaningful words, and drops those sharing only generic ones", async () => {
    withCategory();
    market.listPublicMcp.mockResolvedValue({
      items: [
        candidate("a/storm", "Storm", "Hourly weather detail for every city"),
        candidate("a/db", "Postgres MCP Server", "Cloud API tools for databases"),
      ],
    });
    const html = await render();
    const grid = vi.mocked(
      (await import("../_components/mcp-display")).McpCardGrid,
    );
    const call = grid.mock.calls.at(-1)![0] as {
      items: { identifier: string }[];
    };
    expect(call.items.map((entry) => entry.identifier)).toEqual(["a/storm"]);
    expect(html).toContain("More servers like Weather");
  });

  it("has no related section when nothing shares meaningful words", async () => {
    withCategory();
    market.listPublicMcp.mockResolvedValue({
      items: [candidate("a/db", "Postgres MCP Server", "Cloud API tools")],
    });
    const html = await render();
    expect(html).not.toContain("More servers like");
    expect(navLabels(html)).not.toContain("related");
  });

  it("drops the section, and the query, when the integrations section is shown", async () => {
    withCategory();
    market.getPublicMcpDetail.mockResolvedValue({
      readme: null,
      relatedProduct: {
        domain: "weather.example",
        brand: "weather",
        officialIdentifier: "com.weather/mcp",
        members: [
          { ...manifestResponse.item, identifier: "com.weather/mcp", name: "Weather" },
          { ...manifestResponse.item, identifier: IDENTIFIER, name: "Weather" },
          { ...manifestResponse.item, identifier: "io.github.b/weather-two", name: "Weather Two" },
        ],
      },
      versions: [],
    });
    market.listPublicMcp.mockResolvedValue({
      items: [
        candidate("a/storm", "Storm", "Hourly weather detail for every city"),
      ],
    });
    const html = await render();
    expect(html).toContain('id="integrations"');
    expect(html).not.toContain("More servers like");
    expect(market.listPublicMcp).not.toHaveBeenCalled();
  });
});

// Issue #367 A1: no primary category is guessed.
describe("public MCP detail page primary category", () => {
  it("leads the breadcrumb with a real category and not with 'other'", async () => {
    const withCategories = (categories: string[]) =>
      market.getPublicMcpManifest.mockResolvedValue(
        getMarketMcpManifestResponseSchema.parse({
          ...manifestResponse,
          item: { ...manifestResponse.item, categories },
        }),
      );
    withCategories(["databases"]);
    expect(await render()).toContain("/mcp?category=databases");
    withCategories(["other"]);
    const html = await render();
    expect(html).not.toContain("category=other");
  });
});

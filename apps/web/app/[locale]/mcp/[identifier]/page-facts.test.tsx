import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketMcpManifestResponseSchema } from "@sourceweft/market-contracts";

import enMessages from "../../../../messages/en.json";

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
// suite is about the facts panel.
vi.mock("../_components/mcp-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_components/mcp-display")>()),
  McpCardGrid: () => null,
  McpRuntimeBadge: () => null,
  McpToolRows: () => null,
  McpVerificationBadge: () => null,
}));
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

const IDENTIFIER = "com.notion/mcp";

/**
 * `com.notion/mcp` as the catalog holds it after #367 W1 and W2: a hosted
 * OAuth server with a 26-character registry description, no README, no
 * repository, a publisher derived from its namespace, and the documentation
 * link its 401 answer named. The publisher is spread in after parsing so the
 * fixture reads the same whether or not the contract carries the field yet.
 */
const parsed = getMarketMcpManifestResponseSchema.parse({
  item: {
    createdAt: "2026-09-01T00:00:00.000Z",
    id: "mcp-notion",
    identifier: IDENTIFIER,
    name: "Notion",
    requiresAuth: true,
    status: "published",
    summary: "Notion's official MCP server",
    transport: "streamable_http",
    updatedAt: "2026-10-20T00:00:00.000Z",
    verified: true,
    visibility: "public",
  },
  manifest: {
    identifier: IDENTIFIER,
    name: "Notion",
    schemaVersion: 1,
    summary: "Notion's official MCP server",
    description: "Notion's official MCP server",
    endpointUrl: "https://mcp.notion.com/mcp",
    homepageUrl: "https://www.notion.com",
    auth: { type: "oauth", required: true, posture: "required" },
    tools: [],
    transport: "streamable_http",
    version: "1.0.0",
  },
  version: {
    manifestJson: {},
    provenanceJson: {
      authMetadata: {
        resourceName: "Notion MCP",
        resourceDocumentation: "https://developers.notion.com/docs/mcp",
      },
    },
    status: "published",
    version: "1.0.0",
  },
});
const publisher = {
  domain: "notion.com",
  endpointMatch: true,
  source: "registry-namespace",
};
const notion = {
  ...parsed,
  item: { ...parsed.item, publisher },
  manifest: { ...parsed.manifest, publisher },
};

async function render() {
  const element = await PublicMcpDetailPage({
    params: Promise.resolve({
      identifier: encodeURIComponent(IDENTIFIER),
      locale: "en",
    }),
  });
  return renderToStaticMarkup(element);
}

function factsPanel(html: string) {
  return /<section[^>]*data-testid="mcp-facts-panel"[^>]*>([\s\S]*?)<\/section>/.exec(
    html,
  )?.[1];
}

function fact(panel: string, key: string) {
  return new RegExp(`data-fact="${key}"[^>]*>([\\s\\S]*?)</div>`).exec(
    panel,
  )?.[1];
}

beforeEach(() => {
  market.getPublicMcpManifest.mockReset().mockResolvedValue(notion);
  market.getPublicMcpDetail.mockReset().mockResolvedValue({
    aiOverview: null,
    overviewLocales: [],
    readme: null,
    versions: [],
  });
  market.listPublicMcp.mockReset().mockResolvedValue({ items: [] });
  market.listPublicMcpCategories.mockReset().mockResolvedValue({ items: [] });
});

// #367 W4: an entry the overview rule skips still says what it is.
describe("public MCP detail page facts panel (com.notion/mcp)", () => {
  it("fills the Overview section with the template sentence and the facts", async () => {
    const html = await render();
    const panel = factsPanel(html);
    expect(panel).toBeTruthy();
    expect(html.indexOf('id="overview"')).toBeLessThan(
      html.indexOf("mcp-facts-panel"),
    );
    expect(panel).toContain(
      "Notion&#x27;s hosted MCP server (mcp.notion.com), published by notion.com; OAuth sign-in required; Streamable HTTP.",
    );
    expect(panel).toContain(enMessages.mcp.facts.lead);
    expect(fact(panel!, "publisher")).toContain("notion.com");
    expect(fact(panel!, "endpoint")).toContain("mcp.notion.com");
    expect(fact(panel!, "transport")).toContain("Streamable HTTP");
    expect(fact(panel!, "auth")).toContain(">OAuth<");
    expect(fact(panel!, "auth")).toContain(
      enMessages.mcp.authMethod.explain.oauth,
    );
    // No tools listed: no tool count row rather than "0 tools".
    expect(fact(panel!, "tools")).toBeUndefined();
    expect(fact(panel!, "documentation")).toMatch(
      /<a [^>]*href="https:\/\/developers\.notion\.com\/docs\/mcp"[^>]*rel="nofollow noopener noreferrer"[^>]*target="_blank"[^>]*>developers\.notion\.com/,
    );
    expect(fact(panel!, "homepage")).toContain('href="https://www.notion.com"');
    expect(fact(panel!, "repository")).toBeUndefined();
    // The 26-character description adds nothing beside the hero summary.
    expect(html).not.toContain("divide-y");
  });

  it("counts the tools once the server lists them, and leaves out links it does not declare", async () => {
    market.getPublicMcpManifest.mockResolvedValue({
      ...notion,
      manifest: {
        ...notion.manifest,
        homepageUrl: undefined,
        tools: Array.from({ length: 24 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: {},
          annotations: {},
          risk: "unknown" as const,
        })),
      },
      version: { ...notion.version, provenanceJson: {} },
    });
    const panel = factsPanel(await render())!;
    expect(panel).toContain("Streamable HTTP; 24 tools.");
    expect(fact(panel, "tools")).toContain("24 tools");
    expect(fact(panel, "documentation")).toBeUndefined();
    expect(fact(panel, "homepage")).toBeUndefined();
  });

  it("does without the publisher until the entry has one", async () => {
    market.getPublicMcpManifest.mockResolvedValue(parsed);
    const panel = factsPanel(await render())!;
    expect(panel).toContain(
      "Notion&#x27;s hosted MCP server (mcp.notion.com); OAuth sign-in required; Streamable HTTP.",
    );
    expect(fact(panel, "publisher")).toBeUndefined();
  });

  it("describes the page with the template sentence", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({
        identifier: encodeURIComponent(IDENTIFIER),
        locale: "en",
      }),
    });
    expect(metadata.description).toBe(
      "Notion's hosted MCP server (mcp.notion.com), published by notion.com; OAuth sign-in required; Streamable HTTP.",
    );
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.twitter?.description).toBe(metadata.description);
  });
});

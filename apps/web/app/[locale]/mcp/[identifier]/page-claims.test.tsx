// The owner layer on the public server page (Issue #367, W7): the Claimed
// and Deprecated badges, the owner's Documentation link, and the member-only
// link to the claim page.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketMcpManifestResponseSchema } from "@sourceweft/market-contracts";

const market = vi.hoisted(() => ({
  getPublicMcpDetail: vi.fn(),
  getPublicMcpManifest: vi.fn(),
  listPublicMcp: vi.fn(),
  listPublicMcpCategories: vi.fn(),
}));
const auth = vi.hoisted(() => ({ isSignedIn: false }));

vi.mock("../../../../lib/market-mcp", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
vi.mock("../../../_landing/auth-state-server", () => ({
  resolveInitialLandingAuthState: async () => ({
    isPending: false,
    isSignedIn: auth.isSignedIn,
    user: auth.isSignedIn ? { id: "u1" } : null,
  }),
}));
vi.mock("../../../_landing/components/sourceweft-header", () => ({
  SourceWeftHeader: () => null,
}));
vi.mock("../../../_landing/components/sourceweft-footer", () => ({
  SourceWeftFooter: () => null,
}));
// Async server components, which renderToStaticMarkup cannot render. The
// claim badges are synchronous and stay real.
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

import PublicMcpDetailPage from "./page";

const IDENTIFIER = "com.example/server";

function manifestResponse(input: {
  claimed?: boolean;
  deprecated?: boolean;
  documentationUrl?: string;
  ownerTools?: boolean;
  toolSource?: string;
}) {
  return getMarketMcpManifestResponseSchema.parse({
    item: {
      createdAt: "2026-09-01T00:00:00.000Z",
      id: "mcp-1",
      identifier: IDENTIFIER,
      name: "Example",
      status: "published",
      summary: "An example server.",
      updatedAt: "2026-09-15T00:00:00.000Z",
      visibility: "public",
      ...(input.claimed !== undefined ? { claimed: input.claimed } : {}),
      ...(input.deprecated !== undefined ? { deprecated: input.deprecated } : {}),
    },
    manifest: {
      identifier: IDENTIFIER,
      name: "Example",
      schemaVersion: 1,
      summary: "An example server.",
      endpointUrl: "https://example.com/mcp",
      tools: [
        { name: "ping", ...(input.toolSource ? { source: input.toolSource } : {}) },
      ],
      transport: "streamable_http",
      version: "1.0.0",
      homepageUrl: "https://example.com",
      ...(input.documentationUrl
        ? { documentationUrl: input.documentationUrl }
        : {}),
      ...(input.ownerTools
        ? {
            owner: {
              source: "owner",
              fields: ["tools"],
              toolsSubmittedAt: "2026-10-20T00:00:00.000Z",
              updatedAt: "2026-10-20T00:00:00.000Z",
            },
          }
        : {}),
    },
    version: { manifestJson: {}, status: "published", version: "1.0.0" },
  });
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

function hero(html: string) {
  return /<h1[\s\S]*?<\/h1>([\s\S]*?)<aside/.exec(html)![1]!;
}

function claimLink(html: string) {
  return /<a [^>]*data-testid="mcp-claim-link"[^>]*>([^<]*)<\/a>/.exec(html);
}

beforeEach(() => {
  auth.isSignedIn = false;
  market.getPublicMcpManifest
    .mockReset()
    .mockResolvedValue(manifestResponse({}));
  market.getPublicMcpDetail
    .mockReset()
    .mockResolvedValue({ readme: null, versions: [] });
  market.listPublicMcp.mockReset().mockResolvedValue({ items: [] });
  market.listPublicMcpCategories.mockReset().mockResolvedValue({ items: [] });
});

describe("public MCP detail page owner layer", () => {
  it("shows neither badge nor claim link to a visitor of an unclaimed server", async () => {
    const html = await render();
    expect(html).not.toContain("Claimed by owner");
    expect(html).not.toContain(">Deprecated<");
    expect(html).not.toContain(">Documentation<");
    expect(claimLink(html)).toBeNull();
  });

  it("marks a claimed server in the hero, with the owner's reason in the title", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({ claimed: true }),
    );
    const html = await render();
    expect(hero(html)).toContain("Claimed by owner");
    expect(hero(html)).toContain(
      'title="A verified owner of this server manages its listing on SourceWeft"',
    );
    expect(html).not.toContain(">Deprecated<");
  });

  it("marks a deprecated server with a warning badge", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({ claimed: true, deprecated: true }),
    );
    const html = await render();
    expect(hero(html)).toMatch(/<span[^>]*border-amber[^>]*>[\s\S]*?Deprecated/);
    expect(hero(html)).toContain(
      'title="The owner says this server is no longer maintained"',
    );
  });

  it("links the owner's documentation beside the homepage", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({ documentationUrl: "https://docs.example.com/mcp" }),
    );
    const html = await render();
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/docs\.example\.com\/mcp"[^>]*rel="noreferrer"[^>]*target="_blank"[^>]*>Documentation/,
    );
    expect(html.indexOf(">Homepage<")).toBeLessThan(
      html.indexOf(">Documentation<"),
    );
  });

  it("never renders a documentation link with a non-http scheme", async () => {
    // The server refuses these; the page filters anyway (defence in depth).
    for (const documentationUrl of ["javascript:alert(1)", "data:text/html,hi"]) {
      market.getPublicMcpManifest.mockResolvedValue(
        manifestResponse({ documentationUrl }),
      );
      const html = await render();
      expect(html).not.toContain(">Documentation<");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("data:text/html");
    }
  });

  it("says beside the tool list that the owner submitted it", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({
        claimed: true,
        ownerTools: true,
        toolSource: "owner-submitted",
      }),
    );
    const html = await render();
    expect(html).toContain("Tools listed by the owner");
    expect(html).toContain(
      "treats every tool as having unknown risk.",
    );
    expect(html.indexOf(">Tools<")).toBeLessThan(
      html.indexOf("Tools listed by the owner"),
    );
  });

  it("does not say it for a registry or probed tool list", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({ claimed: true, toolSource: "remote-probe" }),
    );
    expect(await render()).not.toContain("Tools listed by the owner");
    market.getPublicMcpManifest.mockResolvedValue(manifestResponse({}));
    expect(await render()).not.toContain("Tools listed by the owner");
  });

  it("offers a signed-in member the claim page, worded by the server's standing", async () => {
    auth.isSignedIn = true;
    let link = claimLink(await render());
    expect(link?.[1]).toBe("Do you publish this server? Claim it");
    expect(link?.[0]).toContain(
      'href="/dashboard/mcp/claim?identifier=com.example%2Fserver"',
    );
    expect(link?.[0]).toContain('rel="nofollow"');

    market.getPublicMcpManifest.mockResolvedValue(
      manifestResponse({ claimed: true }),
    );
    link = claimLink(await render());
    expect(link?.[1]).toBe("Manage this listing");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketMcpManifestResponseSchema } from "@sourceweft/market-contracts";

const market = vi.hoisted(() => ({
  getPublicMcpDetail: vi.fn(),
  getPublicMcpManifest: vi.fn(),
  getPublicMcpToolRevisions: vi.fn(),
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

import PublicMcpDetailPage from "./page";

const IDENTIFIER = "io.github.o/weather";

function manifestWith(patch: Record<string, unknown>) {
  return getMarketMcpManifestResponseSchema.parse({
    item: {
      createdAt: "2026-09-01T00:00:00.000Z",
      id: "mcp-1",
      identifier: IDENTIFIER,
      name: "Weather",
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
      ...patch,
    },
    version: { manifestJson: {}, status: "published", version: "1.0.0" },
  });
}

async function render() {
  const element = await PublicMcpDetailPage({
    params: Promise.resolve({ identifier: encodeURIComponent(IDENTIFIER), locale: "en" }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  market.getPublicMcpDetail.mockReset().mockResolvedValue({ readme: null, versions: [] });
  market.getPublicMcpToolRevisions.mockReset().mockResolvedValue(null);
  market.listPublicMcp.mockReset().mockResolvedValue({ items: [] });
  market.listPublicMcpCategories.mockReset().mockResolvedValue({ items: [] });
});

describe("public MCP detail page tools reference", () => {
  it("labels a platform-read list with its date, and flags a moved server address", async () => {
    market.getPublicMcpManifest.mockResolvedValue(
      manifestWith({
        toolsReference: {
          source: "platform-indexed",
          observedAt: "2026-10-24T10:00:00.000Z",
          stale: true,
        },
      }),
    );
    const html = await render();
    const tools = /<section[^>]*id="tools"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(tools).toContain("Read by SourceWeft with a standard test account");
    expect(tools).toContain("The server address changed since this was read.");
    expect(tools).not.toContain("Tools listed by the owner");
  });

  it("shows no note for the registry's or the owner's list", async () => {
    market.getPublicMcpManifest.mockResolvedValue(manifestWith({}));
    expect(await render()).not.toContain("mcp-tools-reference");
  });
});

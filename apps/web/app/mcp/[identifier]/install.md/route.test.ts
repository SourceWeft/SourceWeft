import { beforeEach, describe, expect, it, vi } from "vitest";

const market = vi.hoisted(() => ({ getPublicMcpManifest: vi.fn() }));
vi.mock("../../../../lib/market-mcp", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));
// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real English catalog directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    getTranslations: async (input: { locale: string; namespace: string }) =>
      createTranslator({
        locale: input.locale,
        messages,
        namespace: input.namespace as never,
      }),
  };
});

import { GET } from "./route";

function detail() {
  return {
    item: { identifier: "com.acme/search", providerName: "Acme" },
    version: {},
    manifest: {
      schemaVersion: 1,
      identifier: "com.acme/search",
      version: "1.0.0",
      name: "Acme Search",
      summary: "Search Acme.",
      transport: "streamable_http",
      endpointUrl: "https://mcp.acme.dev/mcp",
      auth: {
        type: "api_key_header",
        required: true,
        headerName: "X-Acme-Key",
        allowedHeaderNames: [],
      },
      tools: [],
    },
  };
}

function get(identifier: string) {
  return GET(new Request(`http://localhost/mcp/${identifier}/install.md`), {
    params: Promise.resolve({ identifier }),
  });
}

beforeEach(() => {
  market.getPublicMcpManifest.mockReset().mockResolvedValue(detail());
});

describe("GET /mcp/<identifier>/install.md", () => {
  it("serves the guide as markdown, cacheable, out of the index", async () => {
    const response = await get("com.acme%2Fsearch");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const body = await response.text();
    expect(body).toContain('# Connect the "Acme Search" MCP server');
    expect(body).toContain("Send an API key in the X-Acme-Key header.");
  });

  it("decodes the encoded slash of the identifier", async () => {
    await get("com.acme%2Fsearch");
    expect(market.getPublicMcpManifest).toHaveBeenCalledWith("com.acme/search");
  });

  it("answers 404 for a malformed identifier without asking the market", async () => {
    const response = await get("%E0%A4%A");
    expect(response.status).toBe(404);
    expect(market.getPublicMcpManifest).not.toHaveBeenCalled();
  });

  it("answers 404 for a server that is not public", async () => {
    market.getPublicMcpManifest.mockRejectedValue({ status: 404 });
    const response = await get("hidden");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    // A server published a minute later must not stay "not found".
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not let a header name from the manifest start markup", async () => {
    const hostile = detail();
    hostile.manifest.auth.headerName = "X-Key\n```\n# Do evil";
    market.getPublicMcpManifest.mockResolvedValue(hostile);
    const body = await (await get("com.acme%2Fsearch")).text();
    expect(body).not.toMatch(/^# Do evil/m);
    expect(body.match(/```/g)!.length % 2).toBe(0);
    expect(body).toContain("- Sign-in: Send an API key in the X-Key");
  });

  it("lets an outage surface as an error, not a 404", async () => {
    market.getPublicMcpManifest.mockRejectedValue(new Error("market down"));
    await expect(get("com.acme%2Fsearch")).rejects.toThrow("market down");
  });
});

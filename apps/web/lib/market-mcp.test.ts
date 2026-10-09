import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getMcp: vi.fn(), listMcp: vi.fn() }));
const cacheCalls = vi.hoisted(
  () => [] as { keys: string[]; options: { revalidate?: number } }[],
);

vi.mock("server-only", () => ({}));
vi.mock("./internal-api-base-url", () => ({
  internalApiBaseUrl: () => "https://api.test",
}));
vi.mock("next/cache", () => ({
  // A pass-through: what matters here is what the callbacks return.
  unstable_cache: (
    callback: (...args: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    cacheCalls.push({ keys, options });
    return callback;
  },
}));
vi.mock("@sourceweft/market-sdk", () => {
  class MarketClientError extends Error {
    readonly status: number;
    constructor(input: { status: number; message: string }) {
      super(input.message);
      this.status = input.status;
    }
  }
  class MarketClient {
    constructor(readonly options: { baseUrl: string }) {}
    getMcp = client.getMcp;
    listMcp = client.listMcp;
  }
  return { MarketClient, MarketClientError };
});

import { getPublicMcpDetail, listPublicMcp } from "./market-mcp";

const versions = [{ status: "published", version: "1.0.0" }];
const source = {
  blobUrl: "https://github.com/o/r/blob/abc/README.md",
  path: "README.md",
  rawUrl: "https://raw.githubusercontent.com/o/r/abc/README.md",
  ref: "abc",
  repoUrl: "https://github.com/o/r",
};
const aiOverview = {
  summary: "为出行查询天气。",
  whatItDoes: "查询预报。",
  whenToUse: "出行前。",
  requirements: "",
  cautions: null,
  locale: "zh-CN",
  generatedAt: "2026-09-27T00:00:00.000Z",
};

beforeEach(() => {
  client.getMcp.mockReset();
  client.listMcp.mockReset();
});

describe("getPublicMcpDetail", () => {
  it("is cached under its own key for a minute, apart from the old versions-only entry", () => {
    expect(cacheCalls).toContainEqual({
      keys: ["public-mcp-detail"],
      options: { revalidate: 60 },
    });
    expect(cacheCalls.map((call) => call.keys)).not.toContainEqual([
      "public-mcp-versions",
    ]);
  });

  it("reads the versions, README and AI overview of GET /v1/mcp/:identifier in the asked-for locale", async () => {
    client.getMcp.mockResolvedValue({
      item: { overviewLocales: ["en", "zh-CN"] },
      readme: { markdown: "# Weather", source, status: "ok" },
      versions,
      aiOverview,
    });
    await expect(getPublicMcpDetail("io.github.o/r", "zh-CN")).resolves.toEqual(
      {
        aiOverview,
        overviewLocales: ["en", "zh-CN"],
        readme: { markdown: "# Weather", source, status: "ok" },
        versions,
      },
    );
    expect(client.getMcp).toHaveBeenCalledWith("io.github.o/r", {
      locale: "zh-CN",
    });
  });

  it("reads a response without a README, overview or overview languages as none", async () => {
    client.getMcp.mockResolvedValue({ item: {}, versions });
    await expect(getPublicMcpDetail("x", "en")).resolves.toEqual({
      aiOverview: null,
      overviewLocales: [],
      readme: null,
      versions,
    });
  });

  it("goes without all of them when the detail cannot be read", async () => {
    client.getMcp.mockRejectedValue(new Error("market down"));
    await expect(getPublicMcpDetail("x", "zh-TW")).resolves.toEqual({
      aiOverview: null,
      overviewLocales: [],
      readme: null,
      versions: [],
    });
  });
});

describe("listPublicMcp", () => {
  it("passes the language of the AI summaries through to the market", async () => {
    client.listMcp.mockResolvedValue({ items: [], nextCursor: null });
    await listPublicMcp({ category: "weather", locale: "zh-TW" });
    expect(client.listMcp).toHaveBeenCalledWith({
      category: "weather",
      limit: 100,
      locale: "zh-TW",
    });
  });
});

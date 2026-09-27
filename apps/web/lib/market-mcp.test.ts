import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getMcp: vi.fn() }));
const cacheCalls = vi.hoisted(() => [] as { keys: string[] }[]);

vi.mock("server-only", () => ({}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.mock("next/cache", () => ({
  // A pass-through: what matters here is what the callbacks return.
  unstable_cache: (
    callback: (...args: unknown[]) => unknown,
    keys: string[],
  ) => {
    cacheCalls.push({ keys });
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
  }
  return { MarketClient, MarketClientError };
});

import { getPublicMcpDetail } from "./market-mcp";

const versions = [{ status: "published", version: "1.0.0" }];
const source = {
  blobUrl: "https://github.com/o/r/blob/abc/README.md",
  path: "README.md",
  rawUrl: "https://raw.githubusercontent.com/o/r/abc/README.md",
  ref: "abc",
  repoUrl: "https://github.com/o/r",
};

beforeEach(() => {
  client.getMcp.mockReset();
});

describe("getPublicMcpDetail", () => {
  it("is cached under its own key, apart from the old versions-only entry", () => {
    expect(cacheCalls.map((call) => call.keys)).toContainEqual([
      "public-mcp-detail",
    ]);
    expect(cacheCalls.map((call) => call.keys)).not.toContainEqual([
      "public-mcp-versions",
    ]);
  });

  it("reads the versions and the README of GET /v1/mcp/:identifier", async () => {
    client.getMcp.mockResolvedValue({
      item: {},
      readme: { markdown: "# Weather", source, status: "ok" },
      versions,
    });
    await expect(getPublicMcpDetail("io.github.o/r")).resolves.toEqual({
      readme: { markdown: "# Weather", source, status: "ok" },
      versions,
    });
    expect(client.getMcp).toHaveBeenCalledWith("io.github.o/r");
  });

  it("reads a response without a README as none", async () => {
    client.getMcp.mockResolvedValue({ item: {}, versions });
    await expect(getPublicMcpDetail("x")).resolves.toEqual({
      readme: null,
      versions,
    });
  });

  it("goes without both when the detail cannot be read", async () => {
    client.getMcp.mockRejectedValue(new Error("market down"));
    await expect(getPublicMcpDetail("x")).resolves.toEqual({
      readme: null,
      versions: [],
    });
  });
});

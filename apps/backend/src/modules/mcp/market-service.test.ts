import assert from "node:assert/strict";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMcp: vi.fn(),
}));

vi.mock("@sourceweft/market-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sourceweft/market-sdk")>();
  return {
    ...actual,
    MarketClient: class {
      listMcp = mocks.listMcp;
      getMcp = vi.fn();
      getMcpManifest = vi.fn();
    },
  };
});

vi.mock("../../shared/config", () => ({
  config: {
    market: {
      baseUrl: "http://localhost:3011",
      mode: "official_api",
      serviceToken: "",
    },
  },
}));

import { MarketService } from "./market-service";

test("MarketService returns an empty MCP list when Market API list is unavailable", async () => {
  mocks.listMcp.mockRejectedValue(new TypeError("fetch failed"));

  const result = await new MarketService().listMcp({});

  assert.deepEqual(result, {
    items: [],
    nextCursor: null,
  });
});

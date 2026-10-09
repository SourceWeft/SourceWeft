import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ index: vi.fn(), shard: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./internal-api-base-url", () => ({
  internalApiBaseUrl: () => "https://api.test",
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@sourceweft/market-sdk", () => ({
  MarketClient: class {
    getSitemapIndex = calls.index;
    getSitemapShard = calls.shard;
  },
}));
import {
  getPublicSitemapIndex,
  getPublicSitemapShard,
} from "./sitemap-catalog";
it("propagates catalog failures instead of caching an empty index or shard", async () => {
  calls.index.mockRejectedValue(new Error("offline"));
  calls.shard.mockRejectedValue(new Error("offline"));
  await expect(getPublicSitemapIndex()).rejects.toThrow("offline");
  await expect(getPublicSitemapShard("skills", "a")).rejects.toThrow("offline");
});

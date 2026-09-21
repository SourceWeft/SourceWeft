import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getSkill: vi.fn(),
  listSkillCategories: vi.fn(),
  listSkills: vi.fn(),
}));
const cacheCalls = vi.hoisted(
  () => [] as { keys: string[]; options: { revalidate?: number } }[],
);

vi.mock("server-only", () => ({}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.mock("next/cache", () => ({
  // A pass-through: what matters here is what the callbacks do on failure.
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
    getSkill = client.getSkill;
    listSkillCategories = client.listSkillCategories;
    listSkills = client.listSkills;
  }
  return { MarketClient, MarketClientError };
});

import { MarketClientError } from "@sourceweft/market-sdk";

import {
  getPublicSkill,
  isMarketNotFound,
  listPublicSkillCategories,
  listPublicSkills,
  requirePublicSkillCategories,
} from "./market-skills";

function marketError(status: number) {
  return new MarketClientError({ code: "X", message: "x", status });
}

beforeEach(() => {
  client.getSkill.mockReset();
  client.listSkillCategories.mockReset();
  client.listSkills.mockReset();
});

describe("caching", () => {
  it("caches every read for five minutes under its own key", () => {
    expect(cacheCalls.map((call) => call.keys[0]).sort()).toEqual([
      "public-skill",
      "public-skills-categories",
      "public-skills-list",
    ]);
    for (const call of cacheCalls) {
      expect(call.options.revalidate).toBe(300);
    }
  });
});

describe("listPublicSkills", () => {
  it("passes the request through", async () => {
    const page = { items: [], nextCursor: "next" };
    client.listSkills.mockResolvedValue(page);
    await expect(
      listPublicSkills({ category: "writing", limit: 6, sort: "new" }),
    ).resolves.toBe(page);
    expect(client.listSkills).toHaveBeenCalledWith({
      category: "writing",
      limit: 6,
      sort: "new",
    });
  });

  it("turns an outage into an empty page outside the cache", async () => {
    client.listSkills.mockRejectedValue(marketError(503));
    await expect(listPublicSkills()).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe("categories", () => {
  it("swallows an outage for list pages", async () => {
    client.listSkillCategories.mockRejectedValue(new Error("down"));
    await expect(listPublicSkillCategories()).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it("propagates an outage for category pages, so it is not a 404", async () => {
    client.listSkillCategories.mockRejectedValue(new Error("down"));
    await expect(requirePublicSkillCategories()).rejects.toThrow("down");
  });

  it("returns the categories when the market answers", async () => {
    const response = {
      items: [{ count: 3, description: null, name: "Writing", slug: "writing" }],
      total: 3,
    };
    client.listSkillCategories.mockResolvedValue(response);
    await expect(listPublicSkillCategories()).resolves.toBe(response);
    await expect(requirePublicSkillCategories()).resolves.toBe(response);
  });
});

describe("getPublicSkill", () => {
  it("never swallows: a 404 and an outage stay distinguishable", async () => {
    client.getSkill.mockRejectedValueOnce(marketError(404));
    const notFound = await getPublicSkill("gone").catch((error) => error);
    expect(isMarketNotFound(notFound)).toBe(true);

    client.getSkill.mockRejectedValueOnce(marketError(503));
    const outage = await getPublicSkill("down").catch((error) => error);
    expect(outage).toBeInstanceOf(MarketClientError);
    expect(isMarketNotFound(outage)).toBe(false);
  });

  it("asks the market for the slug", async () => {
    client.getSkill.mockResolvedValue({ skill: { slug: "pdf" } });
    await getPublicSkill("pdf");
    expect(client.getSkill).toHaveBeenCalledWith("pdf");
  });
});

describe("isMarketNotFound", () => {
  it("is only true for a market 404", () => {
    expect(isMarketNotFound(marketError(404))).toBe(true);
    expect(isMarketNotFound(marketError(500))).toBe(false);
    expect(isMarketNotFound(new Error("404"))).toBe(false);
    expect(isMarketNotFound(null)).toBe(false);
  });
});

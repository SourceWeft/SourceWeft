import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ mcp: vi.fn(), skills: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./market-mcp", () => ({ requirePublicMcpCounts: api.mcp }));
vi.mock("./market-skills", () => ({
  requirePublicSkillCategories: api.skills,
}));
import { getLandingMarketStats } from "./landing-market-stats";

beforeEach(() => {
  vi.clearAllMocks();
  api.mcp.mockResolvedValue({ total: 123456, counts: {} });
  api.skills.mockResolvedValue({ total: 98765, items: [] });
});
describe("landing market counts", () => {
  it("uses catalog totals rather than the size of the returned items", async () => {
    expect(await getLandingMarketStats()).toEqual({
      mcp: 123456,
      skills: 98765,
    });
  });
  it("preserves a real zero", async () => {
    api.mcp.mockResolvedValue({ total: 0, counts: {} });
    api.skills.mockResolvedValue({ total: 0, items: [] });
    expect(await getLandingMarketStats()).toEqual({ mcp: 0, skills: 0 });
  });
  it.each(["mcp", "skills"] as const)(
    "keeps the other count when %s fails",
    async (key) => {
      api[key].mockRejectedValue(new Error("unavailable"));
      expect(await getLandingMarketStats()).toEqual({
        mcp: key === "mcp" ? null : 123456,
        skills: key === "skills" ? null : 98765,
      });
    },
  );
  it("reports both unavailable when both fail", async () => {
    api.mcp.mockRejectedValue(new Error("unavailable"));
    api.skills.mockRejectedValue(new Error("unavailable"));
    expect(await getLandingMarketStats()).toEqual({ mcp: null, skills: null });
  });
});

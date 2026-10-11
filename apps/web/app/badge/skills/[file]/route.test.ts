import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderListedBadgeSvg } from "../../../../lib/catalog-badge";

const market = vi.hoisted(() => ({ getPublicSkill: vi.fn() }));
vi.mock("../../../../lib/market-skills", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));

import { GET } from "./route";

function get(file: string, headers?: HeadersInit) {
  return GET(
    new Request(`http://localhost/badge/skills/${file}`, { headers }),
    { params: Promise.resolve({ file }) },
  );
}

function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
}

beforeEach(() => {
  market.getPublicSkill
    .mockReset()
    .mockResolvedValue({ skill: { slug: "gh-ada-skills-pdf" } });
});

describe("GET /badge/skills/<slug>.svg", () => {
  it("serves the listed badge for a public skill, with explicit caching", async () => {
    const response = await get("gh-ada-skills-pdf.svg");
    expect(response.status).toBe(200);
    expect(market.getPublicSkill).toHaveBeenCalledWith("gh-ada-skills-pdf");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "cache-control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "content-type": "image/svg+xml; charset=utf-8",
      etag: '"sw-listed-v1"',
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
    const body = await response.text();
    expect(body).toBe(renderListedBadgeSvg());
    expect(body).not.toContain("gh-ada");
  });

  it("decodes the slug from the path", async () => {
    await get("gh-a%2Bb.svg");
    expect(market.getPublicSkill).toHaveBeenCalledWith("gh-a+b");
  });

  it("answers 404 without asking the market for anything but <slug>.svg", async () => {
    for (const file of [
      "gh-ada-skills-pdf",
      "gh-ada-skills-pdf.svg.png",
      ".svg",
      "%E0%A4%A.svg",
      `${"a".repeat(257)}.svg`,
    ]) {
      expectNotFound(await get(file));
    }
    expect(market.getPublicSkill).not.toHaveBeenCalled();
  });

  it("answers 404 for a slug holding a literal % or a control character, without asking the market", async () => {
    for (const file of [
      "%25.svg",
      "gh-a%25b.svg",
      "gh-a%09b.svg",
      "gh-a%1Fb.svg",
    ]) {
      expectNotFound(await get(file));
    }
    expect(market.getPublicSkill).not.toHaveBeenCalled();
  });

  it("answers 404 for a skill that is not listed", async () => {
    market.getPublicSkill.mockRejectedValue({ status: 404 });
    expectNotFound(await get("hidden.svg"));
  });

  it("lets a market outage surface as an error, never a badge", async () => {
    market.getPublicSkill.mockRejectedValue(new Error("market down"));
    await expect(get("gh-ada-skills-pdf.svg")).rejects.toThrow("market down");
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const response = await get("gh-ada-skills-pdf.svg", {
      "if-none-match": '"sw-listed-v1"',
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe('"sw-listed-v1"');
  });
});

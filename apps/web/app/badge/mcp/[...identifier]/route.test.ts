import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderListedBadgeSvg } from "../../../../lib/catalog-badge";

const market = vi.hoisted(() => ({ getPublicMcpManifest: vi.fn() }));
vi.mock("../../../../lib/market-mcp", () => ({
  ...market,
  isMarketNotFound: (error: unknown) =>
    (error as { status?: number } | null)?.status === 404,
}));

import { GET } from "./route";

const IDENTIFIER = "io.github.o/weather";

function get(segments: string[], headers?: HeadersInit) {
  return GET(
    new Request(`http://localhost/badge/mcp/${segments.join("/")}`, {
      headers,
    }),
    { params: Promise.resolve({ identifier: segments }) },
  );
}

function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeEach(() => {
  market.getPublicMcpManifest
    .mockReset()
    .mockResolvedValue({ item: { identifier: IDENTIFIER } });
});

describe("GET /badge/mcp/<identifier>.svg", () => {
  it("serves the listed badge for a public server, with explicit caching", async () => {
    const response = await get(["io.github.o%2Fweather.svg"]);
    expect(response.status).toBe(200);
    expect(market.getPublicMcpManifest).toHaveBeenCalledWith(IDENTIFIER);
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
    // The picture never carries the entry's own text.
    expect(body).not.toContain("weather");
    expect(body).not.toContain("io.github");
  });

  it("reads the identifier written with %2F or with a bare slash", async () => {
    await get(["io.github.o", "weather.svg"]);
    expect(market.getPublicMcpManifest).toHaveBeenLastCalledWith(IDENTIFIER);
    await get(["io.github.o%2Fweather.svg"]);
    expect(market.getPublicMcpManifest).toHaveBeenLastCalledWith(IDENTIFIER);
  });

  it("answers 404 without asking the market for anything but <identifier>.svg", async () => {
    for (const segments of [
      ["io.github.o%2Fweather"],
      ["io.github.o%2Fweather.png"],
      [".svg"],
      ["%E0%A4%A.svg"],
      [`${"a".repeat(257)}.svg`],
    ]) {
      expectNotFound(await get(segments));
    }
    expect(market.getPublicMcpManifest).not.toHaveBeenCalled();
  });

  it("answers 404 for a key holding a literal % or a control character, without asking the market", async () => {
    // A decoded "%" would be decoded once more on its way to the market and
    // fail there as a 5xx; no identifier contains one, or a control character.
    for (const segments of [
      ["%25.svg"],
      ["io.github.o%2Fweather%25.svg"],
      ["io.github.o", "%2525.svg"],
      ["io.github.o%2Fweat%00her.svg"],
      ["io.github.o%2Fweather%0A.svg"],
      ["io.github.o%2Fweather%7F.svg"],
      ["io.github.o%2Fweather%C2%85.svg"],
    ]) {
      expectNotFound(await get(segments));
    }
    expect(market.getPublicMcpManifest).not.toHaveBeenCalled();
  });

  it("answers 404 for a server that is not listed", async () => {
    market.getPublicMcpManifest.mockRejectedValue({ status: 404 });
    const response = await get(["io.github.o%2Fgone.svg"]);
    expectNotFound(response);
    expect(await response.text()).not.toContain("gone");
  });

  it("lets a market outage surface as an error, never a badge", async () => {
    market.getPublicMcpManifest.mockRejectedValue(new Error("market down"));
    await expect(get(["io.github.o%2Fweather.svg"])).rejects.toThrow(
      "market down",
    );
  });

  it("answers 304 to a matching If-None-Match, once the server is known to be listed", async () => {
    for (const tag of [
      '"sw-listed-v1"',
      'W/"sw-listed-v1"',
      '"other", "sw-listed-v1"',
      "*",
    ]) {
      const response = await get(["io.github.o%2Fweather.svg"], {
        "if-none-match": tag,
      });
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe('"sw-listed-v1"');
      expect(response.headers.get("cache-control")).toContain("max-age=3600");
    }
    const stale = await get(["io.github.o%2Fweather.svg"], {
      "if-none-match": '"sw-listed-v0"',
    });
    expect(stale.status).toBe(200);

    market.getPublicMcpManifest.mockRejectedValue({ status: 404 });
    expectNotFound(
      await get(["io.github.o%2Fweather.svg"], {
        "if-none-match": '"sw-listed-v1"',
      }),
    );
  });
});

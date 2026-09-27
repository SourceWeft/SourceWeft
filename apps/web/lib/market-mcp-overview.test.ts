import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheCalls = vi.hoisted(
  () => [] as { keys: string[]; options: { revalidate?: number } }[],
);

vi.mock("server-only", () => ({}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.mock("next/cache", () => ({
  // A pass-through: what matters here is what the reads do.
  unstable_cache: (
    callback: (...args: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    cacheCalls.push({ keys, options });
    return callback;
  },
}));

import {
  getPublicMcpAiOverview,
  getPublicMcpOverviewLocales,
} from "./market-mcp-overview";

const IDENTIFIER = "io.github.o/weather";

function overview(locale: string) {
  return {
    summary: `Forecasts (${locale}).`,
    whatItDoes: "Looks up forecasts.",
    whenToUse: "Before a trip.",
    requirements: "",
    cautions: null,
    locale,
    generatedAt: "2026-09-27T00:00:00.000Z",
  };
}

const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** The public detail per requested locale; the API falls back to English. */
function serve(
  byLocale: Record<string, string | null>,
  item: Record<string, unknown> = {},
) {
  fetchMock.mockImplementation(async (url: string) => {
    const locale = new URL(url).searchParams.get("locale") ?? "en";
    const written = byLocale[locale] ?? byLocale.en ?? null;
    return answer(200, {
      item,
      versions: [],
      aiOverview: written ? overview(written) : null,
    });
  });
}

function requestedLocales() {
  return fetchMock.mock.calls.map(([url]) =>
    new URL(url as string).searchParams.get("locale"),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("getPublicMcpAiOverview", () => {
  it("reads the public detail in the asked-for locale, cached for a minute", async () => {
    serve({ "zh-CN": "zh-CN" }, { overviewLocales: ["en", "zh-CN"] });
    await expect(getPublicMcpAiOverview(IDENTIFIER, "zh-CN")).resolves.toEqual({
      aiOverview: overview("zh-CN"),
      overviewLocales: ["en", "zh-CN"],
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/v1/mcp/io.github.o%2Fweather?locale=zh-CN",
    );
    expect(cacheCalls).toContainEqual({
      keys: ["public-mcp-ai-overview"],
      options: { revalidate: 60 },
    });
  });

  it("goes without the overview when it cannot be read", async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { code: "X", message: "x" }));
    await expect(getPublicMcpAiOverview(IDENTIFIER, "en")).resolves.toEqual({
      aiOverview: null,
      overviewLocales: null,
    });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(getPublicMcpAiOverview(IDENTIFIER, "en")).resolves.toEqual({
      aiOverview: null,
      overviewLocales: null,
    });
  });
});

describe("getPublicMcpOverviewLocales", () => {
  it("takes the item's own overview languages when the detail names them", async () => {
    serve({ en: "en" }, { overviewLocales: ["en", "zh-TW"] });
    await expect(getPublicMcpOverviewLocales(IDENTIFIER)).resolves.toEqual([
      "zh-TW",
    ]);
    expect(requestedLocales()).toEqual(["en"]);
  });

  it("names none when the item says it has none besides English", async () => {
    serve({ en: "en" }, { overviewLocales: ["en"] });
    await expect(getPublicMcpOverviewLocales(IDENTIFIER)).resolves.toEqual([]);
  });

  it("otherwise counts only answers written in the language asked for", async () => {
    // zh-TW falls back to English: it has no zh-TW overview.
    serve({ en: "en", "zh-CN": "zh-CN" });
    await expect(getPublicMcpOverviewLocales(IDENTIFIER)).resolves.toEqual([
      "zh-CN",
    ]);
    expect(requestedLocales().sort()).toEqual(["en", "zh-CN", "zh-TW"]);
  });

  it("lists nothing when every read fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getPublicMcpOverviewLocales(IDENTIFIER)).resolves.toEqual([]);
  });
});

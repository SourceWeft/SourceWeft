import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));

import {
  getMcpAiOverview,
  getMcpOverviewAdmin,
  mcpCardText,
  mcpOverviewLocale,
  readMcpAiOverview,
  readMcpAiSummary,
  readMcpOverviewAdminState,
  readMcpOverviewDetail,
  readMcpOverviewLocales,
  regenerateMcpOverview,
  setMcpOverviewHidden,
} from "./mcp-ai-overview";

const IDENTIFIER = "io.github.o/weather";

const overview = {
  summary: "Forecasts for any city.",
  whatItDoes: "Looks up forecasts and alerts.",
  whenToUse: "When a trip needs the weather.",
  requirements: "An API key from the weather service.",
  cautions: "Sends city names to a third-party service.",
  locale: "zh-CN",
  generatedAt: "2026-09-27T00:00:00.000Z",
};

describe("readMcpAiOverview", () => {
  it("keeps a well-formed overview, cautions included", () => {
    expect(readMcpAiOverview(overview)).toEqual(overview);
  });

  it("treats blank or missing cautions as none", () => {
    expect(readMcpAiOverview({ ...overview, cautions: "  " })?.cautions).toBe(
      null,
    );
    expect(
      readMcpAiOverview({ ...overview, cautions: undefined })?.cautions,
    ).toBe(null);
  });

  it("reads missing sections as empty, so the block leaves them out", () => {
    expect(readMcpAiOverview({ summary: "S", locale: "en" })).toEqual({
      summary: "S",
      whatItDoes: "",
      whenToUse: "",
      requirements: "",
      cautions: null,
      locale: "en",
      generatedAt: "",
    });
  });

  it("drops an overview with no summary or no language it names", () => {
    expect(readMcpAiOverview({ ...overview, summary: " " })).toBeNull();
    expect(readMcpAiOverview({ ...overview, locale: "fr" })).toBeNull();
    expect(readMcpAiOverview({ ...overview, locale: undefined })).toBeNull();
    expect(readMcpAiOverview(null)).toBeNull();
    expect(readMcpAiOverview("overview")).toBeNull();
  });
});

describe("list and detail fields", () => {
  it("uses the AI summary on a card when there is one, else the summary", () => {
    expect(
      mcpCardText({ summary: "Registry text.", aiSummary: "AI text." } as {
        summary: string;
      }),
    ).toEqual({ text: "AI text.", ai: true });
    for (const aiSummary of [undefined, null, "", "   ", 42]) {
      expect(
        mcpCardText({ summary: "Registry text.", aiSummary } as {
          summary: string;
        }),
      ).toEqual({ text: "Registry text.", ai: false });
    }
    expect(readMcpAiSummary({ aiSummary: "  AI text. " })).toBe("AI text.");
  });

  it("reads overviewLocales without inventing any, and tells absent from none", () => {
    expect(
      readMcpOverviewLocales({ overviewLocales: ["zh-TW", "fr", "en"] }),
    ).toEqual(["en", "zh-TW"]);
    expect(readMcpOverviewLocales({ overviewLocales: [] })).toEqual([]);
    expect(readMcpOverviewLocales({})).toBeNull();
    expect(readMcpOverviewLocales({ overviewLocales: "en" })).toBeNull();
  });

  it("reads a detail answer's overview and item languages", () => {
    expect(
      readMcpOverviewDetail({
        aiOverview: overview,
        item: { overviewLocales: ["en", "zh-CN"] },
      }),
    ).toEqual({ aiOverview: overview, overviewLocales: ["en", "zh-CN"] });
    expect(readMcpOverviewDetail({ item: {} })).toEqual({
      aiOverview: null,
      overviewLocales: null,
    });
  });

  it("maps the app's locale to an overview language, English otherwise", () => {
    expect(mcpOverviewLocale("zh-TW")).toBe("zh-TW");
    expect(mcpOverviewLocale("fr")).toBe("en");
    expect(mcpOverviewLocale(undefined)).toBe("en");
  });

  it("reads the admin state field by field", () => {
    expect(
      readMcpOverviewAdminState({
        entries: [
          {
            locale: "en",
            model: "m",
            hidden: false,
            generatedAt: "2026-09-27T00:00:00.000Z",
          },
          { locale: "fr", model: "m", hidden: true, generatedAt: "" },
          "junk",
        ],
        analysis: { status: "failed", error: "Model unavailable" },
        categoriesSource: "ai",
        eligible: true,
        systemModel: { ready: false, reason: "SYSTEM_MODEL_API_KEY is unset" },
      }),
    ).toEqual({
      entries: [
        {
          locale: "en",
          model: "m",
          hidden: false,
          generatedAt: "2026-09-27T00:00:00.000Z",
        },
      ],
      analysis: { status: "failed", error: "Model unavailable" },
      categoriesSource: "ai",
      eligible: true,
      systemModel: { ready: false, reason: "SYSTEM_MODEL_API_KEY is unset" },
    });
    expect(readMcpOverviewAdminState(null)).toEqual({
      entries: [],
      analysis: null,
      categoriesSource: null,
      eligible: false,
      systemModel: null,
    });
  });
});

describe("API", () => {
  const fetchMock = vi.fn();

  function answer(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("reads the overview from the public detail in the asked-for locale", async () => {
    fetchMock.mockResolvedValue(
      answer(200, { item: {}, versions: [], aiOverview: overview }),
    );
    await expect(getMcpAiOverview(IDENTIFIER, "zh-CN")).resolves.toEqual(
      overview,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.test/v1/mcp/io.github.o%2Fweather?locale=zh-CN",
    );
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("answers null for a server that is not public, and throws on an outage", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(404, { code: "NOT_FOUND", message: "x" }),
    );
    await expect(getMcpAiOverview(IDENTIFIER, "en")).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(
      answer(500, { code: "X", message: "down" }),
    );
    await expect(getMcpAiOverview(IDENTIFIER, "en")).rejects.toThrow("down");
  });

  it("calls the market admin endpoints", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(200, { entries: [], analysis: null, eligible: true }),
    );
    await expect(getMcpOverviewAdmin(IDENTIFIER)).resolves.toMatchObject({
      eligible: true,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview",
    );

    fetchMock.mockResolvedValueOnce(answer(202, { queued: false }));
    await expect(regenerateMcpOverview(IDENTIFIER)).resolves.toEqual({
      queued: false,
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview/regenerate",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST" });

    fetchMock.mockResolvedValueOnce(answer(202, {}));
    await expect(regenerateMcpOverview(IDENTIFIER)).resolves.toEqual({
      queued: null,
    });

    fetchMock.mockResolvedValueOnce(answer(200, { hidden: true }));
    await setMcpOverviewHidden(IDENTIFIER, true);
    const [url, init] = fetchMock.mock.calls[3]!;
    expect(url).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview/hidden",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ hidden: true }),
      credentials: "include",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));

import {
  getMcpOverviewAdmin,
  MCP_OVERVIEW_LOCALES,
  mcpCardText,
  mcpOverviewLocale,
  regenerateMcpOverview,
  setMcpOverviewHidden,
} from "./mcp-ai-overview";

const IDENTIFIER = "io.github.o/weather";

describe("locales and cards", () => {
  it("maps the app's locale to an overview language, English otherwise", () => {
    expect(MCP_OVERVIEW_LOCALES).toEqual(["en", "zh-CN", "zh-TW"]);
    expect(mcpOverviewLocale("zh-TW")).toBe("zh-TW");
    expect(mcpOverviewLocale("zh-CN")).toBe("zh-CN");
    expect(mcpOverviewLocale("fr")).toBe("en");
    expect(mcpOverviewLocale(undefined)).toBe("en");
  });

  it("uses the AI summary on a card when there is one, else the summary", () => {
    expect(
      mcpCardText({ summary: "Registry text.", aiSummary: " AI text. " }),
    ).toEqual({ text: "AI text.", ai: true });
    for (const aiSummary of [undefined, null, "", "   "]) {
      expect(mcpCardText({ summary: "Registry text.", aiSummary })).toEqual({
        text: "Registry text.",
        ai: false,
      });
    }
  });
});

describe("market admin API", () => {
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

  it("reads one server's overview state", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { eligible: true }));
    await expect(getMcpOverviewAdmin(IDENTIFIER)).resolves.toEqual({
      eligible: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview",
    );
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("regenerates, and hides or shows, with credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(202, { identifier: IDENTIFIER, versionId: "v", queued: true }),
    );
    await expect(regenerateMcpOverview(IDENTIFIER)).resolves.toMatchObject({
      queued: true,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview/regenerate",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      credentials: "include",
    });

    fetchMock.mockResolvedValueOnce(
      answer(200, {
        identifier: IDENTIFIER,
        versionId: "v",
        hidden: true,
        updated: 3,
      }),
    );
    await expect(setMcpOverviewHidden(IDENTIFIER, true)).resolves.toMatchObject(
      { hidden: true, updated: 3 },
    );
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      "https://api.test/v1/market/admin/mcp/io.github.o%2Fweather/overview/hidden",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ hidden: true }),
      credentials: "include",
    });
  });

  it("surfaces a refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(403, {
        code: "FORBIDDEN",
        message: "Market admin access required",
      }),
    );
    await expect(getMcpOverviewAdmin(IDENTIFIER)).rejects.toThrow(
      "Market admin access required",
    );
  });
});

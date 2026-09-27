import { describe, expect, it } from "vitest";
import {
  getMarketMcpResponseSchema,
  type MarketMcpReadme,
  type McpReadmeStatus,
} from "@sourceweft/market-contracts";

import {
  hasMcpReadmeToShow,
  isLongMcpReadme,
  mcpReadmeBaseUrl,
  mcpReadmeFallbackLink,
  readMcpReadme,
} from "./mcp-readme";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const source = {
  blobUrl: `https://github.com/o/r/blob/${SHA}/mcp/README.md`,
  path: "mcp/README.md",
  rawUrl: `https://raw.githubusercontent.com/o/r/${SHA}/mcp/README.md`,
  ref: SHA,
  repoUrl: "https://github.com/o/r",
};

function payload(
  status: McpReadmeStatus,
  patch: Partial<MarketMcpReadme> = {},
): MarketMcpReadme {
  return {
    status,
    ...(status === "ok" ? { markdown: "# Title" } : {}),
    source,
    ...patch,
  };
}

/** A detail response as the market SDK hands it over: parsed by the contract. */
function detail(readme?: unknown) {
  return getMarketMcpResponseSchema.parse({
    item: {
      createdAt: "2026-09-01T00:00:00.000Z",
      id: "mcp-1",
      identifier: "io.github.o/r",
      name: "R",
      status: "published",
      summary: "R.",
      updatedAt: "2026-09-01T00:00:00.000Z",
      visibility: "public",
    },
    versions: [],
    ...(readme === undefined ? {} : { readme }),
  });
}

describe("readMcpReadme", () => {
  it("reads the README of a detail response", () => {
    expect(
      readMcpReadme(detail({ markdown: "# Title", source, status: "ok" })),
    ).toEqual({ markdown: "# Title", source, status: "ok" });
    expect(
      readMcpReadme(detail({ source: null, status: "not_found" })),
    ).toEqual({ source: null, status: "not_found" });
  });

  it("is null when the response has no README, or predates them", () => {
    expect(readMcpReadme(detail(null))).toBeNull();
    expect(readMcpReadme(detail())).toBeNull();
  });
});

describe("mcpReadmeBaseUrl", () => {
  it("is the README's own addresses", () => {
    expect(mcpReadmeBaseUrl(source)).toEqual({
      blob: source.blobUrl,
      raw: source.rawUrl,
    });
  });

  it("is undefined without a known README file", () => {
    expect(mcpReadmeBaseUrl(null)).toBeUndefined();
    expect(mcpReadmeBaseUrl(undefined)).toBeUndefined();
  });
});

describe("mcpReadmeFallbackLink", () => {
  it("offers the repository when the README could not be read", () => {
    expect(mcpReadmeFallbackLink(payload("error"))).toEqual({
      href: "https://github.com/o/r",
      kind: "external",
      rel: "nofollow ugc noopener noreferrer",
      target: "_blank",
    });
    const gitlab = { ...source, repoUrl: "https://gitlab.com/o/r" };
    expect(
      mcpReadmeFallbackLink(payload("unsupported_host", { source: gitlab }))
        ?.href,
    ).toBe("https://gitlab.com/o/r");
  });

  it("offers nothing for any other status, or an unsafe address", () => {
    for (const status of [
      "ok",
      "not_found",
      "too_large",
      "pending",
    ] satisfies McpReadmeStatus[]) {
      expect(mcpReadmeFallbackLink(payload(status))).toBeNull();
    }
    expect(
      mcpReadmeFallbackLink(
        payload("error", {
          source: { ...source, repoUrl: "javascript:alert(1)" },
        }),
      ),
    ).toBeNull();
    expect(mcpReadmeFallbackLink(payload("error", { source: null }))).toBe(
      null,
    );
    expect(mcpReadmeFallbackLink(null)).toBeNull();
  });
});

describe("hasMcpReadmeToShow", () => {
  it("shows a README, or why there is none", () => {
    expect(hasMcpReadmeToShow(payload("ok"))).toBe(true);
    expect(hasMcpReadmeToShow(payload("not_found", { source: null }))).toBe(
      true,
    );
    expect(hasMcpReadmeToShow(payload("too_large"))).toBe(true);
  });

  it("shows where to read it when it could not be read here", () => {
    expect(hasMcpReadmeToShow(payload("error"))).toBe(true);
    expect(hasMcpReadmeToShow(payload("unsupported_host"))).toBe(true);
    expect(hasMcpReadmeToShow(payload("error", { source: null }))).toBe(false);
    expect(
      hasMcpReadmeToShow(payload("unsupported_host", { source: null })),
    ).toBe(false);
  });

  it("shows nothing while pending, without a README or with an empty one", () => {
    expect(hasMcpReadmeToShow(payload("pending"))).toBe(false);
    expect(hasMcpReadmeToShow(null)).toBe(false);
    expect(hasMcpReadmeToShow(payload("ok", { markdown: "" }))).toBe(false);
    expect(hasMcpReadmeToShow(payload("ok", { markdown: undefined }))).toBe(
      false,
    );
  });
});

describe("isLongMcpReadme", () => {
  it("folds a README longer than about a screen", () => {
    expect(
      isLongMcpReadme(Array.from({ length: 30 }, () => "x").join("\n")),
    ).toBe(true);
    expect(isLongMcpReadme("x".repeat(3000))).toBe(true);
  });

  it("leaves a short README as it is", () => {
    expect(isLongMcpReadme("# Title\n\nOne paragraph.")).toBe(false);
    expect(
      isLongMcpReadme(Array.from({ length: 29 }, () => "x").join("\n")),
    ).toBe(false);
    expect(isLongMcpReadme("")).toBe(false);
    expect(isLongMcpReadme(undefined)).toBe(false);
  });
});

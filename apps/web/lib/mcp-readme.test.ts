import { describe, expect, it } from "vitest";

import {
  hasMcpReadmeToShow,
  isLongMcpReadme,
  mcpReadmeBaseUrl,
  mcpReadmeFallbackLink,
  readMcpReadme,
  type McpReadmePayload,
  type McpReadmeStatus,
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
  patch: Partial<McpReadmePayload> = {},
): McpReadmePayload {
  return {
    status,
    ...(status === "ok" ? { markdown: "# Title" } : {}),
    source,
    ...patch,
  };
}

describe("readMcpReadme", () => {
  it("reads the README of a detail response", () => {
    expect(
      readMcpReadme({
        item: {},
        readme: { markdown: "# Title", source, status: "ok" },
        versions: [],
      }),
    ).toEqual({ markdown: "# Title", source, status: "ok" });
  });

  it("is null when the response has no README (or is not a response)", () => {
    for (const detail of [
      { item: {}, versions: [] },
      { readme: null },
      { readme: "ok" },
      null,
      undefined,
      "detail",
    ]) {
      expect(readMcpReadme(detail)).toBeNull();
    }
  });

  it("is null for a status it does not know", () => {
    expect(readMcpReadme({ readme: { source, status: "fetching" } })).toBe(
      null,
    );
    expect(readMcpReadme({ readme: { source } })).toBeNull();
  });

  it("keeps markdown only for a README that was read", () => {
    expect(
      readMcpReadme({
        readme: { markdown: "# Title", source, status: "error" },
      }),
    ).toEqual({ source, status: "error" });
    expect(
      readMcpReadme({ readme: { markdown: 42, source, status: "ok" } }),
    ).toEqual({ source, status: "ok" });
  });

  it("reads a missing or partial source as unknown parts", () => {
    expect(readMcpReadme({ readme: { status: "not_found" } })).toEqual({
      source: null,
      status: "not_found",
    });
    expect(
      readMcpReadme({ readme: { source: null, status: "not_found" } })?.source,
    ).toBeNull();
    // No repository to name: no source at all.
    expect(
      readMcpReadme({
        readme: { source: { ...source, repoUrl: "" }, status: "ok" },
      })?.source,
    ).toBeNull();
    expect(
      readMcpReadme({
        readme: {
          source: { blobUrl: 7, path: "", repoUrl: source.repoUrl },
          status: "too_large",
        },
      })?.source,
    ).toEqual({
      blobUrl: null,
      path: null,
      rawUrl: null,
      ref: null,
      repoUrl: source.repoUrl,
    });
  });
});

describe("mcpReadmeBaseUrl", () => {
  it("is the README's own addresses when both are known", () => {
    expect(mcpReadmeBaseUrl(source)).toEqual({
      blob: source.blobUrl,
      raw: source.rawUrl,
    });
  });

  it("is undefined when either is missing", () => {
    expect(mcpReadmeBaseUrl({ blobUrl: source.blobUrl, rawUrl: null })).toBe(
      undefined,
    );
    expect(mcpReadmeBaseUrl({ blobUrl: null, rawUrl: source.rawUrl })).toBe(
      undefined,
    );
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

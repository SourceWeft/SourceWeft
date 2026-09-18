import { describe, expect, it } from "vitest";

import {
  defaultMcpBrowseState,
  isMcpListView,
  mcpBrowseHref,
  mcpCountRequest,
  mcpListRequest,
  parseMcpBrowseState,
} from "./mcp-browse";

const categories = [
  { description: null, id: "1", name: "Developer Tools", slug: "developer-tools" },
];

describe("parseMcpBrowseState", () => {
  it("defaults to the browse home", () => {
    const state = parseMcpBrowseState({}, categories);
    expect(state).toEqual(defaultMcpBrowseState);
    expect(isMcpListView(state)).toBe(false);
  });

  it("accepts the legacy filter param and drops unknown values", () => {
    expect(parseMcpBrowseState({ filter: "developer-tools" }, categories).category).toBe(
      "developer-tools",
    );
    const state = parseMcpBrowseState(
      { category: "nope", runtime: "mainframe", trust: ["official", "x"] },
      categories,
    );
    expect(state).toMatchObject({ category: "all", runtime: "all", trust: "official" });
    expect(isMcpListView(state)).toBe(true);
  });

  it("treats view=all as a listing", () => {
    expect(isMcpListView(parseMcpBrowseState({ view: "all" }, categories))).toBe(true);
  });
});

describe("mcp requests", () => {
  it("maps facets onto the market API", () => {
    const state = {
      ...defaultMcpBrowseState,
      category: "developer-tools",
      cursor: "abc",
      query: "git",
      runtime: "web" as const,
      trust: "verified" as const,
    };
    expect(mcpListRequest(state)).toEqual({
      category: "developer-tools",
      cursor: "abc",
      desktopOnly: false,
      limit: 24,
      query: "git",
      verified: true,
    });
    expect(mcpCountRequest(state)).toEqual({ desktopOnly: false, query: "git" });
    expect(mcpCountRequest(defaultMcpBrowseState)).toEqual({ includeDesktopOnly: true });
  });
});

describe("mcpBrowseHref", () => {
  const state = { ...defaultMcpBrowseState, cursor: "abc", query: "git" };

  it("resets the cursor when filters change", () => {
    expect(mcpBrowseHref(state, { trust: "official" })).toBe("/mcp?q=git&trust=official");
  });

  it("keeps an explicit cursor", () => {
    expect(mcpBrowseHref(state, { cursor: "def" })).toBe("/mcp?q=git&cursor=def");
  });

  it("keeps the listing open when every filter is cleared", () => {
    expect(mcpBrowseHref(defaultMcpBrowseState, { view: true })).toBe("/mcp?view=all");
    expect(mcpBrowseHref(defaultMcpBrowseState)).toBe("/mcp");
  });
});

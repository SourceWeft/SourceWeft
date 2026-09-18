import { describe, expect, it } from "vitest";

import {
  defaultMcpBrowseState,
  isMcpListView,
  mcpBrowseHref,
  mcpCountRequest,
  mcpListRequest,
  parseMcpBrowseState,
} from "./mcp-browse";

describe("parseMcpBrowseState", () => {
  it("defaults to the browse home", () => {
    const state = parseMcpBrowseState({});
    expect(state).toEqual(defaultMcpBrowseState);
    expect(isMcpListView(state)).toBe(false);
  });

  it("takes the category from the route, not the query string", () => {
    expect(
      parseMcpBrowseState({ category: "ignored" }, { category: "developer-tools" })
        .category,
    ).toBe("developer-tools");
    expect(parseMcpBrowseState({ category: "developer-tools" }).category).toBe("all");
  });

  it("drops unknown facet values", () => {
    const state = parseMcpBrowseState({
      runtime: "mainframe",
      trust: ["official", "x"],
    });
    expect(state).toMatchObject({ runtime: "all", trust: "official" });
    expect(isMcpListView(state)).toBe(true);
  });

  it("treats view=all as a listing", () => {
    expect(isMcpListView(parseMcpBrowseState({ view: "all" }))).toBe(true);
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
    expect(mcpCountRequest(defaultMcpBrowseState)).toEqual({
      includeDesktopOnly: true,
    });
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

  it("puts the category in the path so category pages stay indexable", () => {
    expect(mcpBrowseHref(state, { category: "developer-tools", view: true })).toBe(
      "/mcp/category/developer-tools?q=git",
    );
    expect(
      mcpBrowseHref(
        { ...defaultMcpBrowseState, category: "developer-tools" },
        { view: true },
      ),
    ).toBe("/mcp/category/developer-tools");
  });

  it("keeps the listing open when every filter is cleared", () => {
    expect(mcpBrowseHref(defaultMcpBrowseState, { view: true })).toBe("/mcp?view=all");
    expect(mcpBrowseHref(defaultMcpBrowseState)).toBe("/mcp");
  });
});

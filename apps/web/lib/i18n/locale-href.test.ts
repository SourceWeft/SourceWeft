import { describe, expect, it } from "vitest";

import { localeHref } from "./locale-href";

describe("localeHref", () => {
  it("prefixes links into the localized tree for a non-default locale", () => {
    expect(localeHref("/skills/deck-builder", "zh-CN")).toBe(
      "/zh-CN/skills/deck-builder",
    );
    expect(localeHref("/mcp/category/search", "zh-TW")).toBe(
      "/zh-TW/mcp/category/search",
    );
    expect(localeHref("/", "zh-TW")).toBe("/zh-TW");
  });

  it("keeps the query string and fragment", () => {
    expect(localeHref("/skills?view=all&sort=new", "zh-CN")).toBe(
      "/zh-CN/skills?view=all&sort=new",
    );
    expect(localeHref("/mcp?category=search#top", "zh-TW")).toBe(
      "/zh-TW/mcp?category=search#top",
    );
  });

  it("leaves the default locale unprefixed", () => {
    expect(localeHref("/skills/deck-builder", "en")).toBe("/skills/deck-builder");
  });

  it("does not re-prefix an already localized link", () => {
    expect(localeHref("/zh-CN/skills", "zh-TW")).toBe("/zh-TW/skills");
  });

  it("passes app-tree, auth, external and file links through", () => {
    expect(localeHref("/dashboard/skills/x#reviews", "zh-CN")).toBe(
      "/dashboard/skills/x#reviews",
    );
    expect(localeHref("/auth/sign-in?redirectTo=%2Fdashboard", "zh-CN")).toBe(
      "/auth/sign-in?redirectTo=%2Fdashboard",
    );
    expect(localeHref("https://github.com/o/r", "zh-CN")).toBe(
      "https://github.com/o/r",
    );
    expect(localeHref("//cdn.example.com/x", "zh-CN")).toBe(
      "//cdn.example.com/x",
    );
    expect(localeHref("/privacy", "zh-CN")).toBe("/privacy");
  });

  it("falls back to the default locale for an unknown one", () => {
    expect(localeHref("/skills", "fr")).toBe("/skills");
  });
});

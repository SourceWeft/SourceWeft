import { describe, expect, it } from "vitest";
import robots from "./robots";

// Google's matching: `*` is any run of characters, a trailing `$` anchors the
// end, the longest matching rule wins, and allow wins a tie.
function blocked(url: string) {
  const [rule] = [robots().rules].flat();
  const match = (pattern: string) => {
    const anchored = pattern.endsWith("$");
    const body = (anchored ? pattern.slice(0, -1) : pattern)
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`).test(url)
      ? pattern.length
      : -1;
  };
  const longest = (patterns?: string | string[]) =>
    Math.max(-1, ...[patterns ?? []].flat().map(match));
  return longest(rule!.disallow) > longest(rule!.allow);
}

describe("robots.txt", () => {
  it("keeps the app's private areas out of the crawl", () => {
    expect(blocked("/api/v1/market")).toBe(true);
    expect(blocked("/dashboard/chat")).toBe(true);
  });

  it("keeps catalog search and facet permutations out of the crawl in every language", () => {
    for (const prefix of ["", "/zh-CN", "/zh-TW"]) {
      for (const url of [
        "/mcp?q=weather",
        "/mcp?trust=official",
        "/mcp?view=all&runtime=web",
        "/mcp/category/finance?cursor=abc&trust=verified",
        "/skills?sort=new",
        "/skills?view=all&type=scripts",
        "/skills/category/design?q=logo",
        "/skills/pdf-forms?tab=files",
      ]) {
        expect(blocked(`${prefix}${url}`), `${prefix}${url}`).toBe(true);
      }
    }
  });

  it("leaves catalog pages and their plain pagination crawlable in every language", () => {
    for (const prefix of ["", "/zh-CN", "/zh-TW"]) {
      for (const url of [
        "/mcp",
        "/mcp?view=all",
        "/mcp?view=all&cursor=abc",
        "/mcp/category/finance?cursor=abc",
        "/mcp/io.github.o%2Fweather",
        "/skills",
        "/skills?view=all&cursor=abc",
        "/skills/pdf-forms",
      ]) {
        expect(blocked(`${prefix}${url}`), `${prefix}${url}`).toBe(false);
      }
    }
  });

  it("does not reach beyond the catalogs", () => {
    expect(blocked("/blog?tab=latest")).toBe(false);
    expect(blocked("/pricing?type=team")).toBe(false);
  });

  it("keeps React Server Component payloads out of the crawl on every page", () => {
    for (const url of [
      "/?_rsc=1ld0r",
      "/download?_rsc=a1b2c",
      "/zh-TW/download?_rsc=a1b2c",
      "/zh-CN/mcp?category=finance&_rsc=x9",
      "/skills/pdf-forms?_rsc=x9",
    ]) {
      expect(blocked(url), url).toBe(true);
    }
    for (const url of ["/", "/download", "/zh-CN/mcp", "/skills/pdf-forms"]) {
      expect(blocked(url), url).toBe(false);
    }
  });
});

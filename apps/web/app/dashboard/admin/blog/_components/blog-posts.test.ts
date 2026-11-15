import { expect, test } from "vitest";

import {
  blogArticleAdminHref,
  blogPostPublicPath,
  filterBlogGroups,
  groupBlogPosts,
  visibilityOf,
} from "./blog-posts";
import { blogPosts as posts } from "./blog-posts.fixture";

test("groups versions by article, in a fixed language order, newest first", () => {
  const groups = groupBlogPosts(posts);
  expect(groups.map((group) => group.articleId)).toEqual([
    "mcp-server-directories-compared",
    "what-is-mcp",
  ]);
  expect(groups[1]?.versions.map((version) => version.locale)).toEqual([
    "en",
    "zh-CN",
    "zh-TW",
  ]);
  expect(groups[1]?.title).toBe("What is MCP?");
});

test("search matches id, title and slug; the status filter matches any version", () => {
  const groups = groupBlogPosts(posts);
  expect(filterBlogGroups(groups, "什么是", "all").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "zh-tw", "all").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "", "draft").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "", "published")).toHaveLength(2);
  expect(filterBlogGroups(groups, "nothing", "all")).toHaveLength(0);
});

test("visibility and public address", () => {
  expect(visibilityOf({ status: "published", syncEnabled: true })).toBe("published");
  expect(visibilityOf({ status: "published", syncEnabled: false })).toBe("hidden");
  expect(visibilityOf({ status: "draft", syncEnabled: true })).toBe("draft");
  expect(blogPostPublicPath({ locale: "en", slug: "what-is-mcp" })).toBe("/blog/what-is-mcp");
  expect(blogPostPublicPath({ locale: "zh-TW", slug: "what-is-mcp-zh-tw" })).toBe(
    "/zh-TW/blog/what-is-mcp-zh-tw",
  );
});

test("an article's admin address, with or without a language", () => {
  expect(blogArticleAdminHref("what-is-mcp")).toBe("/dashboard/admin/blog/what-is-mcp");
  expect(blogArticleAdminHref("what-is-mcp", "zh-CN")).toBe(
    "/dashboard/admin/blog/what-is-mcp?locale=zh-CN",
  );
});

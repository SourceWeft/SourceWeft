import { afterEach, beforeEach, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  // A pass-through, so every call reaches the (mocked) database.
  unstable_cache: (callback: (...args: unknown[]) => unknown) => callback,
}));
vi.mock("pg", () => ({
  Pool: class {
    query = query;
  },
}));

import {
  BLOG_LINK_BLOCK_TIMEOUT_MS,
  listBlogPostsForLinkBlock,
  listPublishedBlogPosts,
} from "./blog-db";

const row = {
  article_id: "what-is-mcp",
  author_name: null,
  canonical_url: null,
  category: null,
  cover_alt_text: null,
  cover_public_url: null,
  excerpt: "An open protocol.",
  featured: false,
  featured_starts_at: null,
  id: "1",
  locale: "en",
  og_image_public_url: null,
  published_at: "2026-11-20T00:00:00.000Z",
  reading_time_minutes: 6,
  seo_description: null,
  seo_title: null,
  slug: "what-is-mcp",
  tags: ["MCP"],
  title: "What is MCP?",
  updated_at: null,
};

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  query.mockReset();
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  log.mockRestore();
});

it("returns the published articles when the read answers in time", async () => {
  query.mockResolvedValue({ rows: [row] });
  const posts = await listBlogPostsForLinkBlock("en");
  expect(posts.map((post) => post.urlPath)).toEqual(["/blog/what-is-mcp"]);
  expect(log).not.toHaveBeenCalled();
});

it("returns no articles, and says so in the log, when the read fails", async () => {
  query.mockRejectedValue(new Error("connection refused"));
  await expect(listBlogPostsForLinkBlock("en")).resolves.toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
});

it("gives up on a read that does not answer within the bound", async () => {
  vi.useFakeTimers();
  // An unreachable host: the query neither resolves nor rejects.
  query.mockReturnValue(new Promise(() => {}));
  const pending = listBlogPostsForLinkBlock("en");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(BLOG_LINK_BLOCK_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual([]);
  expect(String(log.mock.calls[0]?.[1])).toContain(
    `${BLOG_LINK_BLOCK_TIMEOUT_MS} ms`,
  );
});

it("leaves no timer behind once the read has answered", async () => {
  vi.useFakeTimers();
  query.mockResolvedValue({ rows: [row] });
  await listBlogPostsForLinkBlock("en");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not bound or swallow the blog pages' own read", async () => {
  query.mockRejectedValue(new Error("connection refused"));
  await expect(listPublishedBlogPosts("en")).rejects.toThrow(
    "connection refused",
  );
});

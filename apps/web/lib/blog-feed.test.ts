// @vitest-environment jsdom
import { expect, it } from "vitest";

import type { BlogPostSummary } from "./blog-db";
import {
  BLOG_FEED_MAX_ITEMS,
  blogFeedAlternate,
  blogFeedPath,
  blogFeedXml,
} from "./blog-feed";
import { SITE_URL } from "../app/seo";

function post(overrides: Partial<BlogPostSummary> = {}): BlogPostSummary {
  return {
    articleId: "what-is-mcp",
    authorName: "SourceWeft",
    canonicalUrl: null,
    category: "Guides",
    coverAltText: null,
    coverPublicUrl: null,
    excerpt: "An open protocol for tools.",
    featured: false,
    featuredStartsAt: null,
    id: "1",
    locale: "en",
    ogImagePublicUrl: null,
    publishedAt: new Date("2026-11-20T09:00:00.000Z"),
    readingTimeMinutes: 6,
    seoDescription: null,
    seoTitle: null,
    slug: "what-is-mcp",
    tags: ["MCP"],
    title: "What is MCP?",
    updatedAt: null,
    urlPath: "/blog/what-is-mcp",
    ...overrides,
  };
}

function parse(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  expect(document.querySelector("parsererror")).toBeNull();
  return document;
}

const text = (node: Element | Document, selector: string) =>
  node.querySelector(selector)?.textContent;

it("is well-formed RSS 2.0 with the channel fields a reader needs", () => {
  const xml = blogFeedXml({
    description: "Guides & updates",
    locale: "en",
    posts: [post()],
    title: "SourceWeft Blog",
  });
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  const document = parse(xml);
  expect(document.documentElement.tagName).toBe("rss");
  expect(document.documentElement.getAttribute("version")).toBe("2.0");
  expect(text(document, "channel > title")).toBe("SourceWeft Blog");
  expect(text(document, "channel > link")).toBe(`${SITE_URL}/blog`);
  expect(text(document, "channel > description")).toBe("Guides & updates");
  expect(text(document, "channel > language")).toBe("en");
  const self = document.getElementsByTagName("atom:link")[0];
  expect(self?.getAttribute("href")).toBe(`${SITE_URL}/blog/feed.xml`);
  expect(self?.getAttribute("rel")).toBe("self");
});

it("lists every article with its link, permalink guid, date and tags", () => {
  const document = parse(
    blogFeedXml({
      description: "d",
      locale: "en",
      posts: [post({ tags: ["MCP", "Security"] })],
      title: "t",
    }),
  );
  const items = [...document.querySelectorAll("item")];
  expect(items).toHaveLength(1);
  const item = items[0]!;
  expect(text(item, "title")).toBe("What is MCP?");
  expect(text(item, "link")).toBe(`${SITE_URL}/blog/what-is-mcp`);
  expect(text(item, "guid")).toBe(`${SITE_URL}/blog/what-is-mcp`);
  expect(item.querySelector("guid")?.getAttribute("isPermaLink")).toBe("true");
  expect(text(item, "description")).toBe("An open protocol for tools.");
  expect(text(item, "pubDate")).toBe("Fri, 20 Nov 2026 09:00:00 GMT");
  expect(
    [...item.querySelectorAll("category")].map((node) => node.textContent),
  ).toEqual(["MCP", "Security"]);
});

it("orders newest first, caps the list and dates the channel by the latest change", () => {
  const posts = Array.from({ length: BLOG_FEED_MAX_ITEMS + 5 }, (_, index) =>
    post({
      id: String(index),
      publishedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      slug: `post-${index}`,
      title: `Post ${index}`,
      urlPath: `/blog/post-${index}`,
    }),
  );
  posts[0] = { ...posts[0]!, updatedAt: new Date("2026-12-01T00:00:00.000Z") };
  const document = parse(
    blogFeedXml({ description: "d", locale: "en", posts, title: "t" }),
  );
  const titles = [...document.querySelectorAll("item > title")].map(
    (node) => node.textContent,
  );
  expect(titles).toHaveLength(BLOG_FEED_MAX_ITEMS);
  expect(titles[0]).toBe(`Post ${BLOG_FEED_MAX_ITEMS + 4}`);
  expect(titles).not.toContain("Post 0");
  // Only listed articles date the channel: "Post 0" fell off the list.
  expect(text(document, "channel > lastBuildDate")).toBe(
    new Date(Date.UTC(2026, 0, BLOG_FEED_MAX_ITEMS + 5)).toUTCString(),
  );
});

it("escapes author text and uses each language's own URLs", () => {
  const xml = blogFeedXml({
    description: "d",
    locale: "zh-CN",
    posts: [
      post({
        excerpt: 'Uses <script> & "quotes"',
        locale: "zh-CN",
        slug: "what-is-mcp-zh-cn",
        title: "MCP 是什么 <1>",
        urlPath: "/zh-CN/blog/what-is-mcp-zh-cn",
      }),
    ],
    title: "SourceWeft 博客",
  });
  expect(xml).not.toContain("<script>");
  const document = parse(xml);
  expect(text(document, "item > title")).toBe("MCP 是什么 <1>");
  expect(text(document, "item > description")).toBe('Uses <script> & "quotes"');
  expect(text(document, "item > link")).toBe(
    `${SITE_URL}/zh-CN/blog/what-is-mcp-zh-cn`,
  );
  expect(text(document, "channel > link")).toBe(`${SITE_URL}/zh-CN/blog`);
  expect(text(document, "channel > language")).toBe("zh-CN");
  expect(
    document.getElementsByTagName("atom:link")[0]?.getAttribute("href"),
  ).toBe(`${SITE_URL}/zh-CN/blog/feed.xml`);
});

it("is a valid empty feed before anything is published", () => {
  const document = parse(
    blogFeedXml({ description: "d", locale: "en", posts: [], title: "t" }),
  );
  expect(document.querySelectorAll("item")).toHaveLength(0);
  expect(document.querySelector("lastBuildDate")).toBeNull();
});

it("names the feed of each language for the page head", () => {
  expect(blogFeedPath("en")).toBe("/blog/feed.xml");
  expect(blogFeedPath("zh-TW")).toBe("/zh-TW/blog/feed.xml");
  expect(blogFeedAlternate("zh-TW", "SourceWeft 部落格")).toEqual({
    "application/rss+xml": [
      { title: "SourceWeft 部落格", url: `${SITE_URL}/zh-TW/blog/feed.xml` },
    ],
  });
});

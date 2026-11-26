import { expect, it } from "vitest";

import type { BlogPostSummary } from "./blog-db";
import {
  adjacentBlogPosts,
  latestBlogPosts,
  selectGuidePosts,
} from "./blog-links";

function post(
  articleId: string,
  day: number,
  tags: string[],
  locale: BlogPostSummary["locale"] = "en",
): BlogPostSummary {
  return {
    articleId,
    authorName: null,
    canonicalUrl: null,
    category: null,
    coverAltText: null,
    coverPublicUrl: null,
    excerpt: "",
    featured: false,
    featuredStartsAt: null,
    id: `${articleId}:${locale}`,
    locale,
    ogImagePublicUrl: null,
    publishedAt: new Date(Date.UTC(2026, 10, day)),
    readingTimeMinutes: 5,
    seoDescription: null,
    seoTitle: null,
    slug: locale === "en" ? articleId : `${articleId}-${locale.toLowerCase()}`,
    tags,
    title: articleId,
    updatedAt: null,
    urlPath: `/blog/${articleId}`,
  };
}

const posts = [
  post("what-is-mcp", 1, ["MCP"]),
  post("mcp-servers-for-postgresql-and-databases", 2, ["MCP", "Databases"]),
  post("where-to-find-and-install-agent-skills", 3, ["Agent Skills"]),
  post("how-to-choose-a-trustworthy-mcp-server", 4, ["MCP", "Security"]),
  post("connect-google-drive-and-dropbox-with-only-the-files-you-pick", 5, [
    "Connectors",
  ]),
  post("mcp-servers-for-notion-google-drive-slack", 6, ["MCP", "Notion"]),
  post("generate-a-quiz-from-your-sources", 7, ["SourceWeft Features"]),
];
const ids = (list: BlogPostSummary[]) => list.map((item) => item.articleId);

it("takes the newest articles for the home page whatever order they arrive in", () => {
  expect(ids(latestBlogPosts([...posts].reverse(), 3))).toEqual([
    "generate-a-quiz-from-your-sources",
    "mcp-servers-for-notion-google-drive-slack",
    "connect-google-drive-and-dropbox-with-only-the-files-you-pick",
  ]);
});

it("picks a directory's guides by its tag, newest first", () => {
  expect(ids(selectGuidePosts(posts, { directory: "mcp", limit: 12 }))).toEqual(
    [
      "mcp-servers-for-notion-google-drive-slack",
      "how-to-choose-a-trustworthy-mcp-server",
      "mcp-servers-for-postgresql-and-databases",
      "what-is-mcp",
    ],
  );
  expect(
    ids(selectGuidePosts(posts, { directory: "skills", limit: 12 })),
  ).toEqual(["where-to-find-and-install-agent-skills"]);
  expect(
    ids(selectGuidePosts(posts, { directory: "method", limit: 12 })),
  ).toEqual(["how-to-choose-a-trustworthy-mcp-server"]);
});

it("leads a category page with the category's own articles, then fills by tag", () => {
  expect(
    ids(
      selectGuidePosts(posts, {
        categorySlug: "databases",
        directory: "mcp",
        limit: 3,
      }),
    ),
  ).toEqual([
    "mcp-servers-for-postgresql-and-databases",
    "mcp-servers-for-notion-google-drive-slack",
    "how-to-choose-a-trustworthy-mcp-server",
  ]);
  // A pinned article needs no directory tag, and is never listed twice.
  expect(
    ids(
      selectGuidePosts(posts, {
        categorySlug: "files-storage",
        directory: "mcp",
        limit: 4,
      }),
    ),
  ).toEqual([
    "mcp-servers-for-notion-google-drive-slack",
    "connect-google-drive-and-dropbox-with-only-the-files-you-pick",
    "mcp-servers-for-postgresql-and-databases",
    "what-is-mcp",
  ]);
});

it("starts each category at its own guide, so the categories together link to all of them", () => {
  const pick = (categorySlug: string) =>
    ids(selectGuidePosts(posts, { categorySlug, directory: "mcp", limit: 2 }));
  // The same category always shows the same guides.
  expect(pick("ai-ml")).toEqual(pick("ai-ml"));
  expect(pick("other")).not.toEqual(pick("ai-ml"));
  const shown = new Set(
    ["ai-ml", "other", "cloud-infrastructure", "media-design"].flatMap(pick),
  );
  expect([...shown].sort()).toEqual(
    ids(selectGuidePosts(posts, { directory: "mcp", limit: 12 })).sort(),
  );
});

it("falls back to the tag rule for a category with no mapping or an unpublished pin", () => {
  expect(
    ids(
      selectGuidePosts(posts, {
        categorySlug: "finance",
        directory: "mcp",
        limit: 2,
      }),
    ),
  ).toEqual([
    "mcp-servers-for-notion-google-drive-slack",
    "how-to-choose-a-trustworthy-mcp-server",
  ]);
  expect(
    selectGuidePosts(posts, {
      categorySlug: "documents-office",
      directory: "skills",
      limit: 4,
    }),
  ).toHaveLength(1);
  expect(selectGuidePosts([], { directory: "mcp", limit: 4 })).toEqual([]);
});

it("finds the neighbours of an article within its own language", () => {
  const mixed = [
    ...posts,
    post("what-is-mcp", 1, ["MCP"], "zh-CN"),
    post("generate-a-quiz-from-your-sources", 7, [], "zh-CN"),
  ];
  const middle = adjacentBlogPosts(mixed, {
    id: "how-to-choose-a-trustworthy-mcp-server:en",
    locale: "en",
  });
  expect(middle.newer?.articleId).toBe(
    "connect-google-drive-and-dropbox-with-only-the-files-you-pick",
  );
  expect(middle.older?.articleId).toBe(
    "where-to-find-and-install-agent-skills",
  );
  expect(
    adjacentBlogPosts(mixed, { id: "what-is-mcp:zh-CN", locale: "zh-CN" }),
  ).toMatchObject({
    newer: { id: "generate-a-quiz-from-your-sources:zh-CN" },
    older: null,
  });
  expect(adjacentBlogPosts(mixed, { id: "missing", locale: "en" })).toEqual({
    newer: null,
    older: null,
  });
});

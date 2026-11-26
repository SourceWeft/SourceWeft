import type { BlogPostSummary } from "./blog-db";

/**
 * Which articles the rest of the site links to. Every rule here is a fixed
 * tag or article-id mapping, so the same page always links to the same
 * articles and a change of links is a reviewed change of this file.
 */

/** A page that shows a guides block: the two directories and the method page. */
export type GuideDirectory = "mcp" | "skills" | "method";

/** An article is a guide for a page when it carries the page's tag. */
const DIRECTORY_TAG: Record<GuideDirectory, string> = {
  mcp: "MCP",
  method: "Security",
  skills: "Agent Skills",
};

/**
 * Articles shown first on a category page, keyed by the category slug and
 * naming articles by their `articleId` (the same in every language).
 */
const CATEGORY_GUIDES: Record<
  GuideDirectory,
  Readonly<Record<string, readonly string[]>>
> = {
  mcp: {
    "browser-automation": [
      "mcp-servers-for-web-scraping-and-browser-automation",
    ],
    "communication-collaboration": ["mcp-servers-for-notion-google-drive-slack"],
    "data-analytics": ["mcp-servers-for-postgresql-and-databases"],
    databases: ["mcp-servers-for-postgresql-and-databases"],
    "files-storage": [
      "mcp-servers-for-notion-google-drive-slack",
      "connect-google-drive-and-dropbox-with-only-the-files-you-pick",
    ],
    "knowledge-memory": [
      "mcp-servers-for-notion-google-drive-slack",
      "connect-google-drive-and-dropbox-with-only-the-files-you-pick",
    ],
    "productivity-workflow": ["mcp-servers-for-notion-google-drive-slack"],
    "security-monitoring": ["how-to-choose-a-trustworthy-mcp-server"],
    "web-search-scraping": [
      "mcp-servers-for-web-scraping-and-browser-automation",
    ],
  },
  method: {},
  skills: {
    "data-analytics": ["generate-a-data-table-from-your-sources"],
    development: ["install-skills-and-mcp-in-claude-code"],
    "documents-office": ["agent-skills-for-pdf-word-excel-powerpoint"],
    "learning-education": [
      "generate-flashcards-from-your-sources",
      "generate-a-quiz-from-your-sources",
      "generate-a-mind-map-from-your-sources",
    ],
    "research-analysis": ["generate-a-data-table-from-your-sources"],
    security: ["how-to-check-an-agent-skill-before-installing"],
  },
};

function publishedTime(post: BlogPostSummary) {
  return post.publishedAt ? post.publishedAt.getTime() : 0;
}

/** Newest first; the slug breaks ties so the order never depends on input order. */
function byNewest(left: BlogPostSummary, right: BlogPostSummary) {
  return (
    publishedTime(right) - publishedTime(left) ||
    left.slug.localeCompare(right.slug)
  );
}

function hasTag(post: BlogPostSummary, tag: string) {
  const wanted = tag.toLowerCase();
  return post.tags.some((value) => value.trim().toLowerCase() === wanted);
}

export function latestBlogPosts(posts: BlogPostSummary[], limit: number) {
  return [...posts].sort(byNewest).slice(0, limit);
}

/** A fixed number per category slug, so a category always starts at the same guide. */
function slugOffset(slug: string, length: number) {
  let sum = 0;
  for (const char of slug) {
    sum += char.codePointAt(0) ?? 0;
  }
  return length > 0 ? sum % length : 0;
}

/**
 * Guides for a directory page: the category's pinned articles in their listed
 * order, then the remaining articles tagged for the directory, newest first.
 * On a category page the tagged list starts at a position fixed by the
 * category's slug, so the categories between them link to every guide instead
 * of all repeating the newest few.
 */
export function selectGuidePosts(
  posts: BlogPostSummary[],
  input: { directory: GuideDirectory; categorySlug?: string; limit: number },
) {
  const pinnedIds = input.categorySlug
    ? (CATEGORY_GUIDES[input.directory][input.categorySlug.toLowerCase()] ?? [])
    : [];
  const pinned = pinnedIds.flatMap((articleId) => {
    const post = posts.find((candidate) => candidate.articleId === articleId);
    return post ? [post] : [];
  });
  const pinnedSet = new Set(pinned.map((post) => post.articleId));
  const tagged = posts
    .filter(
      (post) =>
        !pinnedSet.has(post.articleId) &&
        hasTag(post, DIRECTORY_TAG[input.directory]),
    )
    .sort(byNewest);
  const start = input.categorySlug
    ? slugOffset(input.categorySlug.toLowerCase(), tagged.length)
    : 0;
  return [...pinned, ...tagged.slice(start), ...tagged.slice(0, start)].slice(
    0,
    input.limit,
  );
}

/** The articles published just after and just before `current` in its own language. */
export function adjacentBlogPosts(
  posts: BlogPostSummary[],
  current: { id: string; locale: string },
) {
  const ordered = posts
    .filter((post) => post.locale === current.locale)
    .sort(byNewest);
  const index = ordered.findIndex((post) => post.id === current.id);
  if (index === -1) {
    return { newer: null, older: null };
  }
  return {
    newer: ordered[index - 1] ?? null,
    older: ordered[index + 1] ?? null,
  };
}

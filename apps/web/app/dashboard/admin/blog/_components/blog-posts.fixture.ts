import type { BlogAdminPost } from "@sourceweft/contracts";

export const blogPost = (overrides: Partial<BlogAdminPost> = {}): BlogAdminPost => ({
  id: "post_mcp_en",
  articleId: "what-is-mcp",
  locale: "en",
  slug: "what-is-mcp",
  status: "draft",
  syncEnabled: true,
  title: "What is MCP?",
  excerpt: "An open protocol.",
  category: "Guides",
  tags: ["MCP"],
  readingTimeMinutes: 5,
  publishedAt: null,
  syncedAt: "2026-11-15T01:00:00.000Z",
  source: "markdown",
  ...overrides,
});

export const blogPosts: BlogAdminPost[] = [
  blogPost(),
  blogPost({ id: "post_mcp_tw", locale: "zh-TW", slug: "what-is-mcp-zh-tw", title: "什麼是 MCP？" }),
  blogPost({
    id: "post_mcp_cn",
    locale: "zh-CN",
    slug: "what-is-mcp-zh-cn",
    title: "什么是 MCP？",
    status: "published",
    publishedAt: "2026-11-16T00:00:00.000Z",
  }),
  blogPost({
    id: "post_dir_en",
    articleId: "mcp-server-directories-compared",
    slug: "mcp-server-directories-compared",
    title: "MCP server directories compared",
    category: "Comparisons",
    syncedAt: "2026-11-16T02:00:00.000Z",
    status: "published",
    publishedAt: "2026-11-16T02:00:00.000Z",
  }),
];

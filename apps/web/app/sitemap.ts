import type { MetadataRoute } from "next";

import { listPublishedBlogSitemapEntries } from "../lib/blog-db";
import { listPublicMcp } from "../lib/market-mcp";
import { SITE_URL } from "./seo";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const [blogPosts, mcpMarket] = await Promise.all([
    listPublishedBlogSitemapEntries(),
    listPublicMcp({ includeDesktopOnly: true, limit: 100 }),
  ]);

  return [
    {
      changeFrequency: "weekly",
      lastModified,
      priority: 1,
      url: `${SITE_URL}/`,
    },
    {
      changeFrequency: "monthly",
      lastModified,
      priority: 0.3,
      url: `${SITE_URL}/privacy`,
    },
    {
      changeFrequency: "monthly",
      lastModified,
      priority: 0.3,
      url: `${SITE_URL}/terms`,
    },
    {
      changeFrequency: "weekly",
      lastModified,
      priority: 0.6,
      url: `${SITE_URL}/blog`,
    },
    {
      changeFrequency: "daily",
      lastModified,
      priority: 0.7,
      url: `${SITE_URL}/mcp`,
    },
    ...blogPosts.map((post) => ({
      changeFrequency: "monthly" as const,
      lastModified: post.updatedAt ?? post.publishedAt ?? lastModified,
      priority: 0.5,
      url: `${SITE_URL}${post.urlPath}`,
    })),
    ...mcpMarket.items.map((item) => ({
      changeFrequency: "weekly" as const,
      lastModified: item.updatedAt ? new Date(item.updatedAt) : lastModified,
      priority: 0.55,
      url: `${SITE_URL}/mcp/${encodeURIComponent(item.identifier)}`,
    })),
  ];
}

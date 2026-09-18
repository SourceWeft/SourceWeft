import type { MetadataRoute } from "next";
import type { MarketItemSummary } from "@sourceweft/market-sdk";

import { listPublishedBlogSitemapEntries } from "../lib/blog-db";
import { listPublicMcp, listPublicMcpCategories } from "../lib/market-mcp";
import { SITE_URL } from "./seo";

export const dynamic = "force-dynamic";

// Caps the walk at 5,000 servers so a bad cursor cannot stall the sitemap.
const MCP_SITEMAP_MAX_PAGES = 50;

async function listAllPublicMcp() {
  const items: MarketItemSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MCP_SITEMAP_MAX_PAGES; page += 1) {
    const result = await listPublicMcp({
      cursor,
      includeDesktopOnly: true,
      limit: 100,
    });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const [blogPosts, mcpItems, mcpCategories] = await Promise.all([
    listPublishedBlogSitemapEntries(),
    listAllPublicMcp(),
    listPublicMcpCategories(),
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
    ...mcpCategories.items.map((category) => ({
      changeFrequency: "daily" as const,
      lastModified,
      priority: 0.6,
      url: `${SITE_URL}/mcp?category=${encodeURIComponent(category.slug)}`,
    })),
    ...mcpItems.map((item) => ({
      changeFrequency: "weekly" as const,
      lastModified: item.updatedAt ? new Date(item.updatedAt) : lastModified,
      priority: 0.55,
      url: `${SITE_URL}/mcp/${encodeURIComponent(item.identifier)}`,
    })),
  ];
}

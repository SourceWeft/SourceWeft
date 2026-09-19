import type { MetadataRoute } from "next";

import {
  listPublishedBlogPosts,
  listPublishedBlogSitemapEntries,
} from "../lib/blog-db";
import { listPublicMcp, listPublicMcpCategories } from "../lib/market-mcp";
import { blogTagPath } from "./blog/_components/blog-list";
import { mcpCategoryPath } from "./mcp/_components/mcp-display";
import { isIndexableListing, SITE_URL } from "./seo";

export const dynamic = "force-dynamic";

const MCP_SITEMAP_PAGE_LIMIT = 100;
const MCP_SITEMAP_MAX_PAGES = 50;

// The market is cursor-paginated, so one page would silently cap the sitemap at
// the first 100 servers and leave the rest undiscoverable.
async function listAllPublicMcpItems() {
  const items: Awaited<ReturnType<typeof listPublicMcp>>["items"] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MCP_SITEMAP_MAX_PAGES; page += 1) {
    const response: Awaited<ReturnType<typeof listPublicMcp>> =
      await listPublicMcp({
        cursor: cursor ?? undefined,
        includeDesktopOnly: true,
        limit: MCP_SITEMAP_PAGE_LIMIT,
      });
    items.push(...response.items);
    cursor = response.nextCursor;
    if (!cursor) {
      break;
    }
  }

  return items;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Static marketing routes have no real edit timestamp; claiming "now" on every
  // request tells crawlers they change constantly, so they carry no lastModified.
  const [blogPosts, blogPostSummaries, mcpItems, mcpCategories] =
    await Promise.all([
      listPublishedBlogSitemapEntries(),
      listPublishedBlogPosts(),
      listAllPublicMcpItems(),
      listPublicMcpCategories(),
    ]);

  // Listing pages below the threshold render with noindex, so submitting them
  // here would contradict that signal.
  const countByCategory = new Map<string, number>();
  for (const item of mcpItems) {
    for (const category of item.categories) {
      const slug = category.toLowerCase();
      countByCategory.set(slug, (countByCategory.get(slug) ?? 0) + 1);
    }
  }

  const countByTag = new Map<string, number>();
  for (const post of blogPostSummaries) {
    for (const tag of post.tags) {
      countByTag.set(tag, (countByTag.get(tag) ?? 0) + 1);
    }
  }

  const indexableCategories = mcpCategories.items.filter((category) =>
    isIndexableListing(countByCategory.get(category.slug.toLowerCase()) ?? 0),
  );
  const indexableTags = [...countByTag.entries()].filter(([, count]) =>
    isIndexableListing(count),
  );

  return [
    {
      changeFrequency: "weekly",
      priority: 1,
      url: `${SITE_URL}/`,
    },
    {
      changeFrequency: "monthly",
      priority: 0.5,
      url: `${SITE_URL}/about`,
    },
    {
      changeFrequency: "weekly",
      priority: 0.7,
      url: `${SITE_URL}/download`,
    },
    {
      changeFrequency: "weekly",
      priority: 0.4,
      url: `${SITE_URL}/changelog`,
    },
    {
      changeFrequency: "monthly",
      priority: 0.3,
      url: `${SITE_URL}/privacy`,
    },
    {
      changeFrequency: "monthly",
      priority: 0.3,
      url: `${SITE_URL}/terms`,
    },
    {
      changeFrequency: "weekly",
      priority: 0.6,
      url: `${SITE_URL}/blog`,
    },
    {
      changeFrequency: "daily",
      priority: 0.7,
      url: `${SITE_URL}/mcp`,
    },
    ...blogPosts.map((post) => ({
      changeFrequency: "monthly" as const,
      lastModified: post.updatedAt ?? post.publishedAt ?? undefined,
      priority: 0.5,
      url: `${SITE_URL}${post.urlPath}`,
    })),
    ...indexableCategories.map((category) => ({
      changeFrequency: "weekly" as const,
      priority: 0.5,
      url: `${SITE_URL}${mcpCategoryPath(category.slug)}`,
    })),
    ...indexableTags.map(([tag]) => ({
      changeFrequency: "weekly" as const,
      priority: 0.45,
      url: `${SITE_URL}${blogTagPath(tag)}`,
    })),
    ...mcpItems.map((item) => ({
      changeFrequency: "weekly" as const,
      lastModified: item.updatedAt ? new Date(item.updatedAt) : undefined,
      priority: 0.55,
      url: `${SITE_URL}/mcp/${encodeURIComponent(item.identifier)}`,
    })),
  ];
}

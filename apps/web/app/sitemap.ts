import type { MetadataRoute } from "next";

import { listPublishedBlogSitemapEntries } from "../lib/blog-db";
import { SITE_URL } from "./seo";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const blogPosts = await listPublishedBlogSitemapEntries();

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
    ...blogPosts.map((post) => ({
      changeFrequency: "monthly" as const,
      lastModified: post.updatedAt ?? post.publishedAt ?? lastModified,
      priority: 0.5,
      url: `${SITE_URL}${post.urlPath}`,
    })),
  ];
}

import type { MetadataRoute } from "next";

import { blogPosts } from "./blog/data";
import { SITE_URL } from "./seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

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
      lastModified,
      priority: 0.5,
      url: `${SITE_URL}/blog/${post.slug}`,
    })),
  ];
}

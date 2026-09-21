import type { MetadataRoute } from "next";

import {
  listPublishedBlogPosts,
  listPublishedBlogSitemapEntries,
} from "../lib/blog-db";
import { listPublicMcp, listPublicMcpCategories } from "../lib/market-mcp";
import {
  listPublicSkillCategories,
  listPublicSkillCollections,
  listPublicSkills,
} from "../lib/market-skills";
import { blogTagPath } from "./[locale]/blog/_components/blog-list";
import { mcpCategoryPath } from "./[locale]/mcp/_components/mcp-display";
import { isIndexableListing, SITE_URL } from "./seo";
import {
  skillCategoryPath,
  skillCollectionPath,
  skillPath,
} from "./skills/_components/skills-format";
import { sitemapLocaleAlternates } from "../lib/i18n/metadata";

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

const SKILL_SITEMAP_PAGE_LIMIT = 100;
const SKILL_SITEMAP_MAX_PAGES = 50;

// Same cursor walk as the MCP market. `new` sorts on the immutable listing
// date, so a skill cannot move between pages while the walk is in progress. A
// market outage yields an empty page from the swallowing wrapper, which ends
// the walk and leaves the rest of the sitemap intact.
async function listAllPublicSkills() {
  const items: Awaited<ReturnType<typeof listPublicSkills>>["items"] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SKILL_SITEMAP_MAX_PAGES; page += 1) {
    const response: Awaited<ReturnType<typeof listPublicSkills>> =
      await listPublicSkills({
        cursor: cursor ?? undefined,
        limit: SKILL_SITEMAP_PAGE_LIMIT,
        sort: "new",
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
  const [
    blogPosts,
    blogPostSummaries,
    mcpItems,
    mcpCategories,
    skills,
    skillCategories,
    skillCollections,
  ] = await Promise.all([
    listPublishedBlogSitemapEntries(),
    listPublishedBlogPosts(),
    listAllPublicMcpItems(),
    listPublicMcpCategories(),
    listAllPublicSkills(),
    listPublicSkillCategories(),
    listPublicSkillCollections(),
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
  // The skill categories endpoint carries its own public counts, and the
  // category page reads the same number for its noindex decision.
  const indexableSkillCategories = skillCategories.items.filter((category) =>
    isIndexableListing(category.count),
  );
  // Published collections only come back from the API; thin ones render
  // noindex, like a thin category, so they are left out here too.
  const indexableSkillCollections = skillCollections.items.filter(
    (collection) => isIndexableListing(collection.itemCount),
  );
  const indexableTags = [...countByTag.entries()].filter(([, count]) =>
    isIndexableListing(count),
  );

  // Group each article's published locale variants so every entry can carry
  // hreflang links to its real translations (never an untranslated locale).
  const blogUrlsByArticle = new Map<string, Record<string, string>>();
  for (const entry of blogPosts) {
    const group = blogUrlsByArticle.get(entry.articleId) ?? {};
    group[entry.locale] = `${SITE_URL}${entry.urlPath}`;
    blogUrlsByArticle.set(entry.articleId, group);
  }

  return [
    {
      alternates: sitemapLocaleAlternates("/"),
      changeFrequency: "weekly",
      priority: 1,
      url: `${SITE_URL}/`,
    },
    {
      alternates: sitemapLocaleAlternates("/about"),
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
      alternates: sitemapLocaleAlternates("/changelog"),
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
      alternates: sitemapLocaleAlternates("/blog"),
      changeFrequency: "weekly",
      priority: 0.6,
      url: `${SITE_URL}/blog`,
    },
    {
      alternates: sitemapLocaleAlternates("/mcp"),
      changeFrequency: "daily",
      priority: 0.7,
      url: `${SITE_URL}/mcp`,
    },
    {
      changeFrequency: "daily",
      priority: 0.7,
      url: `${SITE_URL}/skills`,
    },
    ...blogPosts.map((post) => {
      const languages = blogUrlsByArticle.get(post.articleId) ?? {};
      return {
        changeFrequency: "monthly" as const,
        lastModified: post.updatedAt ?? post.publishedAt ?? undefined,
        priority: 0.5,
        url: `${SITE_URL}${post.urlPath}`,
        ...(Object.keys(languages).length > 1
          ? { alternates: { languages } }
          : {}),
      };
    }),
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
    ...indexableSkillCategories.map((category) => ({
      changeFrequency: "weekly" as const,
      priority: 0.5,
      url: `${SITE_URL}${skillCategoryPath(category.slug)}`,
    })),
    ...indexableSkillCollections.map((collection) => {
      const modified = new Date(collection.updatedAt);
      return {
        changeFrequency: "weekly" as const,
        lastModified: Number.isNaN(modified.getTime()) ? undefined : modified,
        priority: 0.5,
        url: `${SITE_URL}${skillCollectionPath(collection.slug)}`,
      };
    }),
    ...skills.map((skill) => {
      const modified = new Date(skill.updatedAt ?? skill.listedAt);
      return {
        changeFrequency: "weekly" as const,
        // One unparseable date must not throw away the whole sitemap.
        lastModified: Number.isNaN(modified.getTime()) ? undefined : modified,
        priority: 0.55,
        url: `${SITE_URL}${skillPath(skill.slug)}`,
      };
    }),
  ];
}

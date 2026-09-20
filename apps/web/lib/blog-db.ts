import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import { Pool } from "pg";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@sourceweft/i18n/locales";
import { SITE_URL } from "../app/seo";

export const BLOG_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "ar",
  "he",
  "hi",
  "th",
] as const;

export type BlogLocale = (typeof BLOG_LOCALES)[number];

export type BlogPostSummary = {
  id: string;
  articleId: string;
  locale: BlogLocale;
  slug: string;
  urlPath: string;
  title: string;
  excerpt: string;
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  coverPublicUrl: string | null;
  coverAltText: string | null;
  ogImagePublicUrl: string | null;
  authorName: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  featuredStartsAt: Date | null;
  readingTimeMinutes: number;
  publishedAt: Date | null;
  updatedAt: Date | null;
};

export type BlogPostDetail = BlogPostSummary & {
  contentHtml: string;
  contentText: string;
};

export type BlogSitemapEntry = {
  articleId: string;
  locale: BlogLocale;
  slug: string;
  urlPath: string;
  updatedAt: Date | null;
  publishedAt: Date | null;
};

type BlogRow = {
  id: string;
  article_id: string;
  locale: string;
  slug: string;
  title: string;
  excerpt: string;
  content_html?: string;
  content_text?: string;
  reading_time_minutes: number;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  author_name: string | null;
  category: string | null;
  tags: string[] | null;
  featured: boolean;
  featured_starts_at: Date | string | null;
  published_at: Date | string | null;
  updated_at: Date | string | null;
  cover_public_url: string | null;
  cover_alt_text: string | null;
  og_image_public_url: string | null;
};

const DEFAULT_DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/sourceweft";

const globalForBlogPool = globalThis as typeof globalThis & {
  sourceweftBlogPool?: Pool;
};

function getPool() {
  if (!globalForBlogPool.sourceweftBlogPool) {
    globalForBlogPool.sourceweftBlogPool = new Pool({
      connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    });
  }

  return globalForBlogPool.sourceweftBlogPool;
}

export function blogPostPath(slug: string) {
  return `/blog/${slug}`;
}

export function absoluteBlogPostUrl(slug: string) {
  return `${SITE_URL}${blogPostPath(slug)}`;
}

// Published content is identical for every visitor and only changes when the
// backend `blog:sync` runs, so rows are cached rather than re-queried per hit.
// Rows (not mapped objects) are cached because the data cache round-trip turns
// timestamps into strings, which `normalizeDate` already tolerates.
const BLOG_CACHE_REVALIDATE_SECONDS = 300;

const cachedBlogPostRows = unstable_cache(
  async (locale: string) => (await queryPublishedBlogPostRows(locale)).rows,
  ["blog-published-posts"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

async function queryPublishedBlogPostRows(locale: string) {
  return getPool().query<BlogRow>(
    `
      select
        p.id,
        p.article_id,
        p.locale,
        p.slug,
        p.title,
        p.excerpt,
        p.reading_time_minutes,
        p.seo_title,
        p.seo_description,
        p.canonical_url,
        p.author_name,
        p.category,
        p.tags,
        (
          p.featured = true
          and (p.featured_starts_at is null or p.featured_starts_at <= now())
          and cover.public_url is not null
        ) as featured,
        p.featured_starts_at,
        p.published_at,
        p.updated_at,
        cover.public_url as cover_public_url,
        cover.alt_text as cover_alt_text,
        og.public_url as og_image_public_url
      from blog_posts p
      left join blog_assets cover on cover.id = p.cover_asset_id
      left join blog_assets og on og.id = p.og_image_asset_id
      where p.sync_enabled = true
        and p.status = 'published'
        and p.locale = $1
      order by
        (
          p.featured = true
          and (p.featured_starts_at is null or p.featured_starts_at <= now())
          and cover.public_url is not null
        ) desc,
        case
          when (
            p.featured = true
            and (p.featured_starts_at is null or p.featured_starts_at <= now())
            and cover.public_url is not null
          ) then p.featured_starts_at
        end desc nulls last,
        p.published_at desc nulls last,
        p.synced_at desc
    `,
    [locale],
  );
}

// Per-article fallback: show the requested-locale row for each article group, and
// for groups with no translation in that locale, fall back to the default-locale
// row so the listing is never sparser than English (§17.3 B2).
export async function listPublishedBlogPosts(
  browsingLocale: Locale = DEFAULT_BLOG_LOCALE,
) {
  const requested = await cachedBlogPostRows(browsingLocale);
  if (browsingLocale === DEFAULT_BLOG_LOCALE) {
    return requested.map((row) => mapSummaryRow(row, browsingLocale));
  }
  const seen = new Set(requested.map((row) => row.article_id));
  const fallback = (await cachedBlogPostRows(DEFAULT_BLOG_LOCALE)).filter(
    (row) => !seen.has(row.article_id),
  );
  return [...requested, ...fallback]
    .sort(compareBlogRows)
    .map((row) => mapSummaryRow(row, browsingLocale));
}

const cachedBlogTagRows = unstable_cache(
  async (locales: string[]) => (await queryPublishedBlogTagRows(locales)).rows,
  ["blog-published-tags"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

async function queryPublishedBlogTagRows(locales: string[]) {
  return getPool().query<{ tag: string }>(
    `
      select distinct tag.value as tag
      from blog_posts p
      cross join lateral unnest(p.tags) as tag(value)
      where p.sync_enabled = true
        and p.status = 'published'
        and p.locale = any($1::text[])
        and tag.value <> ''
      order by tag.value asc
    `,
    [locales],
  );
}

export async function listPublishedBlogTags(
  browsingLocale: Locale = DEFAULT_BLOG_LOCALE,
) {
  const locales = [...new Set([browsingLocale, DEFAULT_BLOG_LOCALE])];
  return (await cachedBlogTagRows(locales)).map((row) => row.tag);
}

const cachedBlogPostRow = unstable_cache(
  async (slug: string) => (await queryPublishedBlogPostRow(slug)).rows[0] ?? null,
  ["blog-published-post"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

async function queryPublishedBlogPostRow(slug: string) {
  return getPool().query<BlogRow>(
    `
      select
        p.id,
        p.article_id,
        p.locale,
        p.slug,
        p.title,
        p.excerpt,
        p.content_html,
        p.content_text,
        p.reading_time_minutes,
        p.seo_title,
        p.seo_description,
        p.canonical_url,
        p.author_name,
        p.category,
        p.tags,
        (
          p.featured = true
          and (p.featured_starts_at is null or p.featured_starts_at <= now())
          and cover.public_url is not null
        ) as featured,
        p.featured_starts_at,
        p.published_at,
        p.updated_at,
        cover.public_url as cover_public_url,
        cover.alt_text as cover_alt_text,
        og.public_url as og_image_public_url
      from blog_posts p
      left join blog_assets cover on cover.id = p.cover_asset_id
      left join blog_assets og on og.id = p.og_image_asset_id
      where p.sync_enabled = true
        and p.status = 'published'
        and p.slug = $1
      limit 1
    `,
    [slug],
  );
}

// A slug identifies one row (one article in one locale), so the lookup is by
// slug alone; the URL's locale segment only drives the surrounding chrome. The
// post renders in its own stored language, and `generateMetadata` points the
// canonical at that language's URL (§17.3 B3/B4).
export const getPublishedBlogPost = cache(
  async (slug: string, browsingLocale: Locale = DEFAULT_BLOG_LOCALE) => {
    const row = await cachedBlogPostRow(slug);
    return row
      ? ({
          ...mapSummaryRow(row, browsingLocale),
          contentHtml: row.content_html ?? "",
          contentText: row.content_text ?? "",
        } satisfies BlogPostDetail)
      : null;
  },
);

type BlogSiblingRow = { locale: string; slug: string };

const cachedBlogArticleSiblings = unstable_cache(
  async (articleId: string) =>
    (
      await getPool().query<BlogSiblingRow>(
        `
          select locale, slug
          from blog_posts
          where sync_enabled = true
            and status = 'published'
            and article_id = $1
        `,
        [articleId],
      )
    ).rows,
  ["blog-article-siblings"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

// The published locale variants of one article, for hreflang: only real
// translations are linked, never a locale the article was never translated into
// (§17.3 B4). Non-supported content locales (e.g. ja) are dropped since they
// have no route.
export async function getBlogArticleSiblings(articleId: string) {
  const rows = await cachedBlogArticleSiblings(articleId);
  return rows
    .filter((row): row is { locale: Locale; slug: string } => isLocale(row.locale))
    .map((row) => ({ locale: row.locale, slug: row.slug }));
}

type BlogSitemapRow = {
  article_id: string;
  locale: string;
  slug: string;
  updated_at: Date | string | null;
  published_at: Date | string | null;
};

const cachedBlogSitemapRows = unstable_cache(
  async () => (await queryBlogSitemapRows()).rows,
  ["blog-sitemap-entries"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

async function queryBlogSitemapRows() {
  return getPool().query<BlogSitemapRow>(
    `
      select article_id, locale, slug, updated_at, published_at
      from blog_posts
      where sync_enabled = true
        and status = 'published'
      order by published_at desc nulls last
    `,
  );
}

// Every published row across supported locales, each at its own locale's URL,
// so the sitemap lists real translations (not a cartesian product) with a
// prefix-free default-locale URL (§17.3 B5). Content locales without a route
// (e.g. ja) are dropped.
export async function listPublishedBlogSitemapEntries() {
  return (await cachedBlogSitemapRows())
    .filter((row) => isLocale(row.locale))
    .map(
      (row) =>
        ({
          articleId: row.article_id,
          locale: row.locale as BlogLocale,
          slug: row.slug,
          urlPath: addLocalePrefix(blogPostPath(row.slug), row.locale as Locale),
          updatedAt: normalizeDate(row.updated_at),
          publishedAt: normalizeDate(row.published_at),
        }) satisfies BlogSitemapEntry,
    );
}

const cachedRelatedBlogPostRows = unstable_cache(
  async (articleId: string, locale: BlogLocale, tags: string[], limit: number) =>
    (await queryRelatedBlogPostRows({ articleId, limit, locale, tags })).rows,
  ["blog-related-posts"],
  { revalidate: BLOG_CACHE_REVALIDATE_SECONDS },
);

export async function listRelatedBlogPosts(input: {
  articleId: string;
  locale: BlogLocale;
  tags: string[];
  limit?: number;
}) {
  const rows = await cachedRelatedBlogPostRows(
    input.articleId,
    input.locale,
    input.tags,
    input.limit ?? 3,
  );
  const browsingLocale: Locale = isLocale(input.locale)
    ? input.locale
    : DEFAULT_BLOG_LOCALE;
  return rows.map((row) => mapSummaryRow(row, browsingLocale));
}

async function queryRelatedBlogPostRows(input: {
  articleId: string;
  locale: BlogLocale;
  tags: string[];
  limit: number;
}) {
  return getPool().query<BlogRow>(
    `
      select
        p.id,
        p.article_id,
        p.locale,
        p.slug,
        p.title,
        p.excerpt,
        p.reading_time_minutes,
        p.seo_title,
        p.seo_description,
        p.canonical_url,
        p.author_name,
        p.category,
        p.tags,
        (
          p.featured = true
          and (p.featured_starts_at is null or p.featured_starts_at <= now())
          and cover.public_url is not null
        ) as featured,
        p.featured_starts_at,
        p.published_at,
        p.updated_at,
        cover.public_url as cover_public_url,
        cover.alt_text as cover_alt_text,
        og.public_url as og_image_public_url
      from blog_posts p
      left join blog_assets cover on cover.id = p.cover_asset_id
      left join blog_assets og on og.id = p.og_image_asset_id
      where p.sync_enabled = true
        and p.status = 'published'
        and p.locale = $1
        and p.article_id <> $2
      order by
        case when p.tags && $3::text[] then 0 else 1 end,
        (
          select count(*)
          from unnest(p.tags) as post_tag(value)
          where post_tag.value = any($3::text[])
        ) desc,
        p.published_at desc nulls last
      limit $4
    `,
    [input.locale, input.articleId, input.tags, input.limit],
  );
}

// Fallback / default content locale; also the locale whose URLs carry no prefix.
const DEFAULT_BLOG_LOCALE: Locale = DEFAULT_LOCALE;

function compareBlogRows(a: BlogRow, b: BlogRow): number {
  if (a.featured !== b.featured) {
    return a.featured ? -1 : 1;
  }
  const aTime = a.published_at ? new Date(a.published_at).getTime() : 0;
  const bTime = b.published_at ? new Date(b.published_at).getTime() : 0;
  return bTime - aTime;
}

// `urlPath` is prefixed with the *browsing* locale (the `[locale]` segment), so
// a card always keeps the reader in their chosen language even when the post
// itself is a default-locale fallback (§17.3 B2).
function mapSummaryRow(row: BlogRow, browsingLocale: Locale): BlogPostSummary {
  return {
    id: row.id,
    articleId: row.article_id,
    locale: (row.locale as BlogLocale) ?? DEFAULT_BLOG_LOCALE,
    slug: row.slug,
    urlPath: addLocalePrefix(blogPostPath(row.slug), browsingLocale),
    title: row.title,
    excerpt: row.excerpt,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    canonicalUrl: row.canonical_url,
    coverPublicUrl: row.cover_public_url,
    coverAltText: row.cover_alt_text,
    ogImagePublicUrl: row.og_image_public_url,
    authorName: row.author_name,
    category: row.category,
    tags: row.tags ?? [],
    featured: row.featured,
    featuredStartsAt: normalizeDate(row.featured_starts_at),
    readingTimeMinutes: row.reading_time_minutes,
    publishedAt: normalizeDate(row.published_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function normalizeDate(value: Date | string | null) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

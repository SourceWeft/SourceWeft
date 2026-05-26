import "server-only";

import { Pool } from "pg";
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

const PUBLIC_BLOG_LOCALE: BlogLocale = "en";

function getPool() {
  if (!globalForBlogPool.sourceweftBlogPool) {
    globalForBlogPool.sourceweftBlogPool = new Pool({
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- Runtime database configuration is supplied by deployment/Compose, not Turbo cache inputs.
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

export async function listPublishedBlogPosts() {
  const result = await getPool().query<BlogRow>(
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
    [PUBLIC_BLOG_LOCALE],
  );

  return result.rows.map(mapSummaryRow);
}

export async function listPublishedBlogTags() {
  const result = await getPool().query<{ tag: string }>(
    `
      select distinct tag.value as tag
      from blog_posts p
      cross join lateral unnest(p.tags) as tag(value)
      where p.sync_enabled = true
        and p.status = 'published'
        and p.locale = $1
        and tag.value <> ''
      order by tag.value asc
    `,
    [PUBLIC_BLOG_LOCALE],
  );

  return result.rows.map((row) => row.tag);
}

export async function getPublishedBlogPost(slug: string) {
  const result = await getPool().query<BlogRow>(
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
        and p.locale = $1
        and p.slug = $2
      limit 1
    `,
    [PUBLIC_BLOG_LOCALE, slug],
  );

  const row = result.rows[0];
  return row
    ? ({
        ...mapSummaryRow(row),
        contentHtml: row.content_html ?? "",
        contentText: row.content_text ?? "",
      } satisfies BlogPostDetail)
    : null;
}

export async function listPublishedBlogSitemapEntries() {
  const result = await getPool().query<{
    article_id: string;
    locale: string;
    slug: string;
    updated_at: Date | string | null;
    published_at: Date | string | null;
  }>(
    `
      select article_id, locale, slug, updated_at, published_at
      from blog_posts
      where sync_enabled = true
        and status = 'published'
        and locale = $1
      order by published_at desc nulls last
    `,
    [PUBLIC_BLOG_LOCALE],
  );

  return result.rows.map(
    (row) =>
      ({
        articleId: row.article_id,
        locale: PUBLIC_BLOG_LOCALE,
        slug: row.slug,
        urlPath: blogPostPath(row.slug),
        updatedAt: normalizeDate(row.updated_at),
        publishedAt: normalizeDate(row.published_at),
      }) satisfies BlogSitemapEntry,
  );
}

export async function listRelatedBlogPosts(input: {
  articleId: string;
  locale: BlogLocale;
  tags: string[];
  limit?: number;
}) {
  const result = await getPool().query<BlogRow>(
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
    [input.locale, input.articleId, input.tags, input.limit ?? 3],
  );

  return result.rows.map(mapSummaryRow);
}

function mapSummaryRow(row: BlogRow): BlogPostSummary {
  return {
    id: row.id,
    articleId: row.article_id,
    locale: PUBLIC_BLOG_LOCALE,
    slug: row.slug,
    urlPath: blogPostPath(row.slug),
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

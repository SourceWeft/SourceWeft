import { createHash } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { blogAssets, blogPosts, db } from "@sourceweft/db";
import type { BlogLocale } from "./locales";
import type { UploadedBlogAsset } from "./public-storage";

export type BlogPostStatus = "draft" | "published" | "archived";
export type BlogAssetKind = "cover" | "og_image" | "content_image" | "file";

/**
 * `metadata_json.source` on a row written from a Markdown file. Rows without it
 * come from Notion.
 */
export const BLOG_SOURCE_MARKDOWN = "markdown";

export type BlogPostUpsertInput = {
  id: string;
  articleId: string;
  locale: BlogLocale;
  slug: string;
  syncEnabled: boolean;
  status: BlogPostStatus;
  title: string;
  excerpt: string;
  contentHtml: string;
  contentText: string;
  readingTimeMinutes: number;
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  ogImageAssetId: string | null;
  coverAssetId: string | null;
  authorName: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  featuredStartsAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  sourceLastEditedAt: Date | null;
  contentHash: string;
  metadataJson: Record<string, unknown>;
};

export function buildBlogPostId(articleId: string, locale: BlogLocale) {
  const digest = createHash("sha256")
    .update(`${articleId}:${locale}`)
    .digest("hex")
    .slice(0, 28);

  return `blog_post_${digest}`;
}

export function buildBlogAssetId(input: {
  postId: string;
  kind: BlogAssetKind;
  sha256: string;
}) {
  const digest = createHash("sha256")
    .update(`${input.postId}:${input.kind}:${input.sha256}`)
    .digest("hex")
    .slice(0, 28);

  return `blog_asset_${digest}`;
}

export async function upsertBlogPost(input: BlogPostUpsertInput) {
  const now = new Date();

  await db
    .insert(blogPosts)
    .values({
      id: input.id,
      articleId: input.articleId,
      locale: input.locale,
      slug: input.slug,
      syncEnabled: input.syncEnabled,
      status: input.status,
      title: input.title,
      excerpt: input.excerpt,
      contentHtml: input.contentHtml,
      contentText: input.contentText,
      readingTimeMinutes: input.readingTimeMinutes,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
      canonicalUrl: input.canonicalUrl,
      ogImageAssetId: input.ogImageAssetId,
      coverAssetId: input.coverAssetId,
      authorName: input.authorName,
      category: input.category,
      tags: input.tags,
      featured: input.featured,
      featuredStartsAt: input.featuredStartsAt,
      publishedAt: input.publishedAt,
      updatedAt: input.updatedAt,
      sourceLastEditedAt: input.sourceLastEditedAt,
      contentHash: input.contentHash,
      metadataJson: input.metadataJson,
      syncedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [blogPosts.articleId, blogPosts.locale],
      set: {
        slug: input.slug,
        syncEnabled: input.syncEnabled,
        status: input.status,
        title: input.title,
        excerpt: input.excerpt,
        contentHtml: input.contentHtml,
        contentText: input.contentText,
        readingTimeMinutes: input.readingTimeMinutes,
        seoTitle: input.seoTitle,
        seoDescription: input.seoDescription,
        canonicalUrl: input.canonicalUrl,
        ogImageAssetId: input.ogImageAssetId,
        coverAssetId: input.coverAssetId,
        authorName: input.authorName,
        category: input.category,
        tags: input.tags,
        featured: input.featured,
        featuredStartsAt: input.featuredStartsAt,
        publishedAt: input.publishedAt,
        updatedAt: input.updatedAt,
        sourceLastEditedAt: input.sourceLastEditedAt,
        contentHash: input.contentHash,
        metadataJson: input.metadataJson,
        syncedAt: now,
      },
    });
}

export async function upsertBlogPostShell(input: {
  id: string;
  articleId: string;
  locale: BlogLocale;
  slug: string;
  syncEnabled: boolean;
  status: BlogPostStatus;
  title: string;
  excerpt: string;
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  authorName: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  featuredStartsAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  sourceLastEditedAt: Date | null;
  metadataJson: Record<string, unknown>;
}) {
  const now = new Date();

  await db
    .insert(blogPosts)
    .values({
      id: input.id,
      articleId: input.articleId,
      locale: input.locale,
      slug: input.slug,
      syncEnabled: input.syncEnabled,
      status: input.status,
      title: input.title,
      excerpt: input.excerpt,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
      canonicalUrl: input.canonicalUrl,
      authorName: input.authorName,
      category: input.category,
      tags: input.tags,
      featured: input.featured,
      featuredStartsAt: input.featuredStartsAt,
      publishedAt: input.publishedAt,
      updatedAt: input.updatedAt,
      sourceLastEditedAt: input.sourceLastEditedAt,
      metadataJson: input.metadataJson,
      syncedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [blogPosts.articleId, blogPosts.locale],
      set: {
        slug: input.slug,
        syncEnabled: input.syncEnabled,
        status: input.status,
        title: input.title,
        excerpt: input.excerpt,
        seoTitle: input.seoTitle,
        seoDescription: input.seoDescription,
        canonicalUrl: input.canonicalUrl,
        authorName: input.authorName,
        category: input.category,
        tags: input.tags,
        featured: input.featured,
        featuredStartsAt: input.featuredStartsAt,
        publishedAt: input.publishedAt,
        updatedAt: input.updatedAt,
        sourceLastEditedAt: input.sourceLastEditedAt,
        metadataJson: input.metadataJson,
        syncedAt: now,
      },
    });
}

export async function upsertBlogAsset(input: {
  id: string;
  postId: string;
  assetKind: BlogAssetKind;
  asset: UploadedBlogAsset;
  altText: string | null;
}) {
  await db
    .insert(blogAssets)
    .values({
      id: input.id,
      postId: input.postId,
      assetKind: input.assetKind,
      storageBucket: input.asset.storageBucket,
      storageKey: input.asset.storageKey,
      publicUrl: input.asset.publicUrl,
      contentType: input.asset.contentType,
      sizeBytes: input.asset.sizeBytes,
      sha256: input.asset.sha256,
      sourceUrlHash: input.asset.sourceUrlHash,
      altText: input.altText,
    })
    .onConflictDoUpdate({
      target: [blogAssets.postId, blogAssets.assetKind, blogAssets.sha256],
      set: {
        storageBucket: input.asset.storageBucket,
        storageKey: input.asset.storageKey,
        publicUrl: input.asset.publicUrl,
        contentType: input.asset.contentType,
        sizeBytes: input.asset.sizeBytes,
        sourceUrlHash: input.asset.sourceUrlHash,
        altText: input.altText,
      },
    });
}

export async function markBlogPostHidden(input: {
  id: string;
}) {
  await db
    .update(blogPosts)
    .set({
      status: "archived",
      syncEnabled: false,
      syncedAt: new Date(),
    })
    .where(eq(blogPosts.id, input.id));
}

export async function listBlogPostIdentities(input: {
  articleId?: string | null;
  locale?: BlogLocale | null;
}) {
  const conditions = [
    input.articleId ? eq(blogPosts.articleId, input.articleId) : null,
    input.locale ? eq(blogPosts.locale, input.locale) : null,
  ].filter((condition) => condition !== null);

  const query = db
    .select({
      id: blogPosts.id,
      articleId: blogPosts.articleId,
      locale: blogPosts.locale,
      metadataJson: blogPosts.metadataJson,
    })
    .from(blogPosts);

  const rows =
    conditions.length > 0 ? await query.where(and(...conditions)) : await query;

  return rows.map((row) => ({
    id: row.id,
    articleId: row.articleId,
    locale: row.locale,
    source: sourceOf(row.metadataJson),
  }));
}

export async function pruneBlogAssets(input: {
  postId: string;
  keepAssetIds: string[];
}) {
  if (input.keepAssetIds.length === 0) {
    await db.delete(blogAssets).where(eq(blogAssets.postId, input.postId));
    return;
  }

  await db
    .delete(blogAssets)
    .where(
      and(
        eq(blogAssets.postId, input.postId),
        notInArray(blogAssets.id, input.keepAssetIds),
      ),
    );
}


function sourceOf(metadataJson: Record<string, unknown> | null | undefined) {
  return metadataJson?.source === BLOG_SOURCE_MARKDOWN
    ? ("markdown" as const)
    : ("notion" as const);
}

const adminSummaryColumns = {
  id: blogPosts.id,
  articleId: blogPosts.articleId,
  locale: blogPosts.locale,
  slug: blogPosts.slug,
  status: blogPosts.status,
  syncEnabled: blogPosts.syncEnabled,
  title: blogPosts.title,
  excerpt: blogPosts.excerpt,
  category: blogPosts.category,
  tags: blogPosts.tags,
  readingTimeMinutes: blogPosts.readingTimeMinutes,
  publishedAt: blogPosts.publishedAt,
  syncedAt: blogPosts.syncedAt,
  metadataJson: blogPosts.metadataJson,
};

function toAdminSummary<
  Row extends { metadataJson: Record<string, unknown> },
>(row: Row) {
  const { metadataJson, ...rest } = row;
  return { ...rest, source: sourceOf(metadataJson) };
}

/** Every post, whatever its status, for the admin's list. */
export async function listBlogPostsForAdmin() {
  const rows = await db
    .select(adminSummaryColumns)
    .from(blogPosts)
    .orderBy(desc(blogPosts.syncedAt), blogPosts.articleId, blogPosts.locale);
  return rows.map(toAdminSummary);
}

/** One post with its rendered body, for the admin's preview. */
export async function getBlogPostForAdmin(id: string) {
  const [row] = await db
    .select({ ...adminSummaryColumns, contentHtml: blogPosts.contentHtml })
    .from(blogPosts)
    .where(eq(blogPosts.id, id))
    .limit(1);
  if (!row) {
    return null;
  }
  const { contentHtml, ...summary } = row;
  return { ...toAdminSummary(summary), contentHtml };
}

/** The status and publish date of the posts that exist among `ids`. */
export async function getBlogPostStates(ids: string[]) {
  const states = new Map<
    string,
    { status: BlogPostStatus; publishedAt: Date | null }
  >();
  if (ids.length === 0) {
    return states;
  }
  const rows = await db
    .select({
      id: blogPosts.id,
      status: blogPosts.status,
      publishedAt: blogPosts.publishedAt,
    })
    .from(blogPosts)
    .where(inArray(blogPosts.id, ids));
  for (const row of rows) {
    states.set(row.id, { status: row.status, publishedAt: row.publishedAt });
  }
  return states;
}

/**
 * Publish, unpublish or archive a post. Publishing makes it visible whatever
 * source it came from and dates it now when it has no publish date yet.
 */
export async function setBlogPostStatus(input: {
  id: string;
  status: BlogPostStatus;
}) {
  const [current] = await db
    .select({ publishedAt: blogPosts.publishedAt })
    .from(blogPosts)
    .where(eq(blogPosts.id, input.id))
    .limit(1);
  if (!current) {
    return null;
  }

  await db
    .update(blogPosts)
    .set(
      input.status === "published"
        ? {
            status: "published",
            syncEnabled: true,
            publishedAt: current.publishedAt ?? new Date(),
          }
        : { status: input.status },
    )
    .where(eq(blogPosts.id, input.id));

  return getBlogPostForAdmin(input.id);
}

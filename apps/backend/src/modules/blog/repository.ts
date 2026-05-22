import { createHash } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../../shared/database";
import { blogAssets, blogPosts } from "../../shared/db/schema";
import type { BlogLocale } from "./locales";
import type { UploadedBlogAsset } from "./public-storage";

export type BlogPostStatus = "draft" | "published" | "archived";
export type BlogAssetKind = "cover" | "og_image" | "content_image" | "file";

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
    })
    .from(blogPosts);

  const rows =
    conditions.length > 0 ? await query.where(and(...conditions)) : await query;

  return rows;
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

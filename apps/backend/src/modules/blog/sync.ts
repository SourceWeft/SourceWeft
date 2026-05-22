import { createHash } from "node:crypto";
import { BLOG_LOCALES, normalizeBlogLocale, type BlogLocale } from "./locales";
import { getBlogDataSource, queryBlogPages } from "./notion-client";
import {
  parseBlogPage,
  validateBlogDataSourceTemplate,
  type ParsedBlogPage,
  type ParsedNotionFile,
} from "./notion-properties";
import { renderNotionPageContent } from "./notion-renderer";
import {
  buildBlogAssetId,
  buildBlogPostId,
  listBlogPostIdentities,
  markBlogPostHidden,
  pruneBlogAssets,
  upsertBlogAsset,
  upsertBlogPost,
  upsertBlogPostShell,
  type BlogAssetKind,
} from "./repository";
import {
  downloadAndUploadBlogAsset,
  validatePublicS3Config,
} from "./public-storage";

export type SyncNotionBlogOptions = {
  dryRun?: boolean;
  validateOnly?: boolean;
  locale?: BlogLocale | null;
  articleId?: string | null;
};

export type SyncNotionBlogResult = {
  scanned: number;
  validated: number;
  upserted: number;
  hidden: number;
  skipped: number;
  dryRun: boolean;
  validateOnly: boolean;
};

export async function syncNotionBlog(options: SyncNotionBlogOptions = {}) {
  const dryRun = Boolean(options.dryRun);
  const validateOnly = Boolean(options.validateOnly);

  validatePublicS3Config();
  const dataSource = await getBlogDataSource();
  validateBlogDataSourceTemplate(dataSource);

  const pages = await queryBlogPages({ filter: buildNotionFilter(options) });
  const parsedPages = pages.map((page) => parseBlogPage(page));
  validateParsedPages(parsedPages);

  const result: SyncNotionBlogResult = {
    scanned: pages.length,
    validated: parsedPages.length,
    upserted: 0,
    hidden: 0,
    skipped: parsedPages.filter(
      (page) => !page.syncEnabled || page.status !== "published",
    ).length,
    dryRun,
    validateOnly,
  };

  if (validateOnly) {
    return result;
  }

  const seenIds = new Set<string>();

  for (const parsedPage of parsedPages) {
    const postId = buildBlogPostId(parsedPage.articleId, parsedPage.locale);
    seenIds.add(postId);

    if (dryRun) {
      result.upserted += 1;
      continue;
    }

    await upsertBlogPostShell({
      id: postId,
      articleId: parsedPage.articleId,
      locale: parsedPage.locale,
      slug: parsedPage.slug,
      syncEnabled: parsedPage.syncEnabled,
      status: parsedPage.status,
      title: parsedPage.title,
      excerpt: parsedPage.excerpt,
      seoTitle: parsedPage.seoTitle,
      seoDescription: parsedPage.seoDescription,
      canonicalUrl: parsedPage.canonicalUrl,
      authorName: parsedPage.authorName,
      category: parsedPage.category,
      tags: parsedPage.tags,
      featured: parsedPage.featured,
      featuredStartsAt: parsedPage.featuredStartsAt,
      publishedAt: parsedPage.publishedAt,
      updatedAt: parsedPage.updatedAt,
      sourceLastEditedAt: parsedPage.sourceLastEditedAt,
      metadataJson: buildMetadataJson(parsedPage),
    });

    const assetIds: string[] = [];
    const coverAssetId = await syncPageAsset({
      parsedPage,
      postId,
      assetKind: "cover",
      file: parsedPage.cover,
      dryRun,
    });
    const ogImageAssetId = await syncPageAsset({
      parsedPage,
      postId,
      assetKind: "og_image",
      file: parsedPage.ogImage,
      dryRun,
    });

    if (coverAssetId) {
      assetIds.push(coverAssetId);
    }
    if (ogImageAssetId) {
      assetIds.push(ogImageAssetId);
    }

    const rendered = await renderNotionPageContent({
      pageId: parsedPage.notionPageId,
      articleId: parsedPage.articleId,
      locale: parsedPage.locale,
      postId,
      dryRun,
    });
    assetIds.push(...rendered.assetIds);

    await upsertBlogPost({
      id: postId,
      articleId: parsedPage.articleId,
      locale: parsedPage.locale,
      slug: parsedPage.slug,
      syncEnabled: parsedPage.syncEnabled,
      status: parsedPage.status,
      title: parsedPage.title,
      excerpt: parsedPage.excerpt,
      contentHtml: rendered.contentHtml,
      contentText: rendered.contentText,
      readingTimeMinutes: rendered.readingTimeMinutes,
      seoTitle: parsedPage.seoTitle,
      seoDescription: parsedPage.seoDescription,
      canonicalUrl: parsedPage.canonicalUrl,
      ogImageAssetId,
      coverAssetId,
      authorName: parsedPage.authorName,
      category: parsedPage.category,
      tags: parsedPage.tags,
      featured: parsedPage.featured,
      featuredStartsAt: parsedPage.featuredStartsAt,
      publishedAt: parsedPage.publishedAt,
      updatedAt: parsedPage.updatedAt,
      sourceLastEditedAt: parsedPage.sourceLastEditedAt,
      contentHash: rendered.contentHash,
      metadataJson: buildMetadataJson(parsedPage),
    });

    await pruneBlogAssets({ postId, keepAssetIds: assetIds });
    result.upserted += 1;
  }

  if (!dryRun) {
    const existing = await listBlogPostIdentities({
      articleId: options.articleId ?? null,
      locale: options.locale ?? null,
    });
    for (const row of existing) {
      if (!seenIds.has(row.id)) {
        await markBlogPostHidden({ id: row.id });
        result.hidden += 1;
      }
    }
  }

  return result;
}

function buildNotionFilter(options: SyncNotionBlogOptions) {
  const filters: Record<string, unknown>[] = [];

  if (options.articleId) {
    filters.push({
      property: "Article ID",
      rich_text: {
        equals: options.articleId,
      },
    });
  }

  if (options.locale) {
    filters.push({
      property: "Locale",
      select: {
        equals: options.locale,
      },
    });
  }

  if (filters.length === 0) {
    return undefined;
  }

  if (filters.length === 1) {
    return filters[0];
  }

  return { and: filters };
}

function validateParsedPages(pages: ParsedBlogPage[]) {
  const pageKeys = new Map<string, ParsedBlogPage>();
  const slugKeys = new Map<string, ParsedBlogPage>();
  const errors: string[] = [];

  for (const page of pages) {
    const pageKey = `${page.articleId}:${page.locale}`;
    const slugKey = `${page.locale}:${page.slug}`;
    if (pageKeys.has(pageKey)) {
      errors.push(`Duplicate Article ID + Locale: ${pageKey}`);
    }
    if (slugKeys.has(slugKey)) {
      errors.push(`Duplicate Locale + Slug: ${slugKey}`);
    }

    pageKeys.set(pageKey, page);
    slugKeys.set(slugKey, page);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

async function syncPageAsset(input: {
  parsedPage: ParsedBlogPage;
  postId: string;
  assetKind: BlogAssetKind;
  file: ParsedNotionFile | null;
  dryRun: boolean;
}) {
  if (!input.file || input.dryRun) {
    return null;
  }

  const uploaded = await downloadAndUploadBlogAsset({
    articleId: input.parsedPage.articleId,
    locale: input.parsedPage.locale,
    sourceUrl: input.file.url,
    fallbackFileName: input.file.name,
    contentTypeHint: input.file.contentTypeHint,
  });
  const assetId = buildBlogAssetId({
    postId: input.postId,
    kind: input.assetKind,
    sha256: uploaded.sha256,
  });

  await upsertBlogAsset({
    id: assetId,
    postId: input.postId,
    assetKind: input.assetKind,
    asset: uploaded,
    altText: input.parsedPage.title,
  });

  return assetId;
}

function buildMetadataJson(page: ParsedBlogPage) {
  return {
    featured_starts_at: page.featuredStartsAt?.toISOString() ?? null,
    notion_source_hash: createHash("sha256")
      .update(page.notionPageId)
      .digest("hex"),
    tags: page.tags,
  };
}

export function parseSyncLocale(value: string | undefined) {
  if (!value) {
    return null;
  }

  const locale = normalizeBlogLocale(value);
  if (!locale) {
    throw new Error(
      `Invalid locale "${value}". Supported locales: ${BLOG_LOCALES.join(", ")}`,
    );
  }

  return locale;
}

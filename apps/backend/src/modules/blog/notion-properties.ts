import { BLOG_LOCALES, normalizeBlogLocale, type BlogLocale } from "./locales";
import type {
  NotionBlockFile,
  NotionDataSource,
  NotionFileObject,
  NotionPage,
  NotionProperty,
  NotionRichText,
} from "./notion-client";
import type { BlogPostStatus } from "./repository";
import { isRecord } from "../../shared/records";

export const REQUIRED_BLOG_PROPERTIES = [
  ["Sync", "checkbox"],
  ["Article ID", "rich_text"],
  ["Locale", "select"],
  ["Slug", "rich_text"],
  ["Status", "select"],
  ["Title", "title"],
  ["Excerpt", "rich_text"],
  ["Published At", "date"],
  ["SEO Title", "rich_text"],
  ["SEO Description", "rich_text"],
  ["Canonical URL", "url"],
  ["OG Image", "files"],
  ["Author", "rich_text"],
  ["Category", "select"],
  ["Tags", "multi_select"],
  ["Cover", "files"],
  ["Featured", "checkbox"],
  ["Featured Starts At", "date"],
  ["Updated At", "date"],
] as const;

export type ParsedBlogPage = {
  notionPageId: string;
  articleId: string;
  locale: BlogLocale;
  slug: string;
  syncEnabled: boolean;
  status: BlogPostStatus;
  title: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  canonicalUrl: string | null;
  ogImage: ParsedNotionFile | null;
  cover: ParsedNotionFile | null;
  authorName: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  featuredStartsAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  sourceLastEditedAt: Date | null;
};

export type ParsedNotionFile = {
  url: string;
  name: string;
  contentTypeHint: string | null;
};

export function validateBlogDataSourceTemplate(dataSource: NotionDataSource) {
  const properties = dataSource.properties ?? {};
  const errors: string[] = [];

  for (const [name, type] of REQUIRED_BLOG_PROPERTIES) {
    const property = properties[name];
    if (!property) {
      errors.push(`Missing Notion property: ${name}`);
      continue;
    }

    if (property.type !== type) {
      errors.push(
        `Notion property "${name}" must be ${type}, got ${property.type ?? "unknown"}`,
      );
    }
  }

  const localeOptions =
    properties.Locale?.select?.options?.map((option) => option.name) ?? [];
  const missingLocales = BLOG_LOCALES.filter(
    (locale) => !localeOptions.includes(locale),
  );
  if (missingLocales.length > 0) {
    errors.push(
      `Locale select is missing options: ${missingLocales.join(", ")}`,
    );
  }

  const statusOptions =
    properties.Status?.select?.options?.map((option) => option.name) ??
    properties.Status?.status?.options?.map((option) => option.name) ??
    [];
  const missingStatuses = ["Draft", "Published", "Archived"].filter(
    (status) => !statusOptions.includes(status),
  );
  if (missingStatuses.length > 0) {
    errors.push(
      `Status select is missing options: ${missingStatuses.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

export function parseBlogPage(page: NotionPage) {
  const property = (name: string) => page.properties[name];
  const title = readText(property("Title")).trim();
  const excerpt = readText(property("Excerpt")).trim();
  const seoTitle = readText(property("SEO Title")).trim() || title;
  const seoDescription =
    readText(property("SEO Description")).trim() || excerpt;
  const locale = normalizeBlogLocale(readSelect(property("Locale")));
  const rawStatus = readSelect(property("Status"));
  const status = normalizeStatus(rawStatus);
  const articleId = readText(property("Article ID")).trim();
  const slug = normalizeSlug(readText(property("Slug")));
  const canonicalUrl = normalizeCanonicalUrl(
    readUrl(property("Canonical URL")),
  );
  const publishedAt = readDate(property("Published At"));
  const featuredStartsAt = readDate(property("Featured Starts At"));
  const updatedAt = readDate(property("Updated At"));
  const sourceLastEditedAt = page.last_edited_time
    ? new Date(page.last_edited_time)
    : null;

  const errors: string[] = [];
  if (!articleId) {
    errors.push("Article ID is required");
  }
  if (!locale) {
    errors.push(`Locale must be one of: ${BLOG_LOCALES.join(", ")}`);
  }
  if (!slug) {
    errors.push("Slug is required");
  }
  if (!title) {
    errors.push("Title is required");
  }
  if (!seoTitle) {
    errors.push("SEO Title fallback is required");
  }
  if (!seoDescription) {
    errors.push("SEO Description fallback is required");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Notion page ${page.id}:\n${errors.join("\n")}`);
  }

  return {
    notionPageId: page.id,
    articleId,
    locale: locale as BlogLocale,
    slug,
    syncEnabled: readCheckbox(property("Sync")),
    status,
    title,
    excerpt,
    seoTitle,
    seoDescription,
    canonicalUrl,
    ogImage: firstFile(property("OG Image")),
    cover: firstFile(property("Cover")) ?? blockFileToParsed(page.cover),
    authorName: readText(property("Author")).trim() || null,
    category: readSelect(property("Category")) || null,
    tags: readMultiSelect(property("Tags")),
    featured: readCheckbox(property("Featured")),
    featuredStartsAt,
    publishedAt,
    updatedAt,
    sourceLastEditedAt,
  } satisfies ParsedBlogPage;
}

export function richTextToPlainText(richText: NotionRichText[] | undefined) {
  return (richText ?? []).map((text) => text.plain_text ?? "").join("");
}

function namedObject(value: unknown) {
  return isRecord(value) && typeof value.name === "string" ? value.name : "";
}

function readText(property: NotionProperty | undefined) {
  if (!property) {
    return "";
  }

  if (property.type === "title") {
    const title = isRecord(property) ? property.title : undefined;
    return richTextToPlainText(Array.isArray(title) ? title : undefined);
  }

  if (property.type === "rich_text") {
    const richText = isRecord(property) ? property.rich_text : undefined;
    return richTextToPlainText(Array.isArray(richText) ? richText : undefined);
  }

  return "";
}

function readCheckbox(property: NotionProperty | undefined) {
  return property?.type === "checkbox" ? Boolean(property.checkbox) : false;
}

function readSelect(property: NotionProperty | undefined) {
  if (property?.type === "select") {
    return namedObject(property.select).trim();
  }

  if (property?.type === "status") {
    return namedObject(property.status).trim();
  }

  return "";
}

function readMultiSelect(property: NotionProperty | undefined) {
  if (property?.type !== "multi_select") {
    return [];
  }

  const values = Array.isArray(property.multi_select)
    ? property.multi_select
    : [];
  return values.map((item) => namedObject(item).trim()).filter(Boolean);
}

function readUrl(property: NotionProperty | undefined) {
  return property?.type === "url" && typeof property.url === "string"
    ? property.url.trim() || null
    : null;
}

function readDate(property: NotionProperty | undefined) {
  const date =
    property?.type === "date" && isRecord(property.date) ? property.date : null;
  const start = typeof date?.start === "string" ? date.start : null;
  if (!start) {
    return null;
  }

  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStatus(status: string): BlogPostStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === "published") {
    return "published";
  }
  if (normalized === "archived") {
    return "archived";
  }

  return "draft";
}

function normalizeSlug(value: string) {
  const slug = value.trim().replace(/^\/+|\/+$/g, "");
  if (!slug || slug.includes("/") || slug.includes("?") || slug.includes("#")) {
    return "";
  }

  return slug;
}

function normalizeCanonicalUrl(value: string | null) {
  if (!value) {
    return null;
  }

  const url = new URL(value);
  if (url.hostname !== "sourceweft.com" || !url.pathname.startsWith("/blog")) {
    throw new Error(
      "Canonical URL must be on sourceweft.com and start with /blog",
    );
  }

  return url.toString();
}

function firstFile(property: NotionProperty | undefined) {
  if (property?.type !== "files") {
    return null;
  }

  const files = Array.isArray(property.files) ? property.files : [];
  return fileToParsed(files[0]);
}

function fileToParsed(file: NotionFileObject | undefined) {
  if (!file) {
    return null;
  }

  const url = file.type === "external" ? file.external?.url : file.file?.url;
  if (!url) {
    return null;
  }

  return {
    url,
    name: file.name || "asset",
    contentTypeHint: null,
  } satisfies ParsedNotionFile;
}

function blockFileToParsed(file: NotionBlockFile | null | undefined) {
  if (!file) {
    return null;
  }

  const url = file.type === "external" ? file.external?.url : file.file?.url;
  if (!url) {
    return null;
  }

  return {
    url,
    name: "cover",
    contentTypeHint: null,
  } satisfies ParsedNotionFile;
}

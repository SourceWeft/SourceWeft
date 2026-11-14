import { parse as parseYaml } from "yaml";
import { BLOG_LOCALES, normalizeBlogLocale, type BlogLocale } from "./locales";
import type { BlogPostStatus } from "./repository";
import { isRecord } from "../../shared/records";

/** One article in one language, as written in a Markdown file. */
export type ParsedMarkdownPost = {
  sourcePath: string;
  articleId: string;
  locale: BlogLocale;
  slug: string;
  status: BlogPostStatus;
  title: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  canonicalUrl: string | null;
  authorName: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  publishedAt: Date | null;
  updatedAt: Date | null;
  body: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const STATUSES: readonly BlogPostStatus[] = ["draft", "published", "archived"];
const KNOWN_KEYS = new Set([
  "articleId",
  "locale",
  "slug",
  "status",
  "title",
  "excerpt",
  "seoTitle",
  "seoDescription",
  "canonicalUrl",
  "author",
  "category",
  "tags",
  "featured",
  "publishedAt",
  "updatedAt",
]);

/**
 * A Markdown article file: YAML front matter with the same fields a Notion row
 * carries, then the body. Every problem in the file is reported at once, with
 * the file's path, so a batch can be fixed in one pass.
 */
export function parseMarkdownPost(
  fileText: string,
  sourcePath: string,
): ParsedMarkdownPost {
  const fail = (errors: string[]): never => {
    throw new Error(
      `${sourcePath}:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
    );
  };

  // A UTF-8 byte order mark before the first --- would hide the front matter.
  const match = FRONT_MATTER.exec(
    fileText.charCodeAt(0) === 0xfeff ? fileText.slice(1) : fileText,
  );
  if (!match) {
    return fail(["Missing YAML front matter (a block between --- lines)"]);
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    return fail([
      `Front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (!isRecord(data)) {
    return fail(["Front matter must be a YAML mapping"]);
  }

  const errors: string[] = [];
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`Unknown front matter field: ${key}`);
    }
  }

  const text = (key: string) => {
    const value = data[key];
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value !== "string") {
      errors.push(`${key} must be a string`);
      return "";
    }
    return value.trim();
  };

  const articleId = text("articleId");
  if (!articleId) {
    errors.push("articleId is required");
  }

  const localeValue = text("locale");
  const locale = normalizeBlogLocale(localeValue);
  if (!locale) {
    errors.push(`locale must be one of: ${BLOG_LOCALES.join(", ")}`);
  }

  const slug = normalizeSlug(text("slug"));
  if (!slug) {
    errors.push("slug is required and must not contain /, ? or #");
  }

  const title = text("title");
  if (!title) {
    errors.push("title is required");
  }

  const excerpt = text("excerpt");
  if (!excerpt) {
    errors.push("excerpt is required");
  }

  const statusValue = (text("status") || "draft").toLowerCase();
  const status = STATUSES.find((candidate) => candidate === statusValue);
  if (!status) {
    errors.push(`status must be one of: ${STATUSES.join(", ")}`);
  }

  const publishedAt = readDate(data.publishedAt, "publishedAt", errors);
  const updatedAt = readDate(data.updatedAt, "updatedAt", errors);
  if (status === "published" && !publishedAt) {
    errors.push("publishedAt is required when status is published");
  }

  let canonicalUrl: string | null = null;
  const canonicalValue = text("canonicalUrl");
  if (canonicalValue) {
    try {
      const url = new URL(canonicalValue);
      if (
        url.hostname !== "sourceweft.com" ||
        !url.pathname.startsWith("/blog")
      ) {
        errors.push(
          "canonicalUrl must be on sourceweft.com and start with /blog",
        );
      } else {
        canonicalUrl = url.toString();
      }
    } catch {
      errors.push("canonicalUrl must be an absolute URL");
    }
  }

  let tags: string[] = [];
  if (data.tags !== undefined && data.tags !== null) {
    if (
      Array.isArray(data.tags) &&
      data.tags.every((tag): tag is string => typeof tag === "string")
    ) {
      tags = data.tags.map((tag) => tag.trim()).filter(Boolean);
    } else {
      errors.push("tags must be a list of strings");
    }
  }

  let featured = false;
  if (data.featured !== undefined && data.featured !== null) {
    if (typeof data.featured === "boolean") {
      featured = data.featured;
    } else {
      errors.push("featured must be true or false");
    }
  }

  const body = (match[2] ?? "").trim();
  if (!body) {
    errors.push("The article body is empty");
  }

  if (errors.length > 0 || !locale || !status) {
    return fail(errors);
  }

  return {
    sourcePath,
    articleId,
    locale,
    slug,
    status,
    title,
    excerpt,
    seoTitle: text("seoTitle") || title,
    seoDescription: text("seoDescription") || excerpt,
    canonicalUrl,
    authorName: text("author") || null,
    category: text("category") || null,
    tags,
    featured,
    publishedAt,
    updatedAt,
    body,
  };
}

/** The same two uniqueness rules the Notion sync and the database enforce. */
export function validateMarkdownPosts(posts: ParsedMarkdownPost[]) {
  const byArticleLocale = new Map<string, string>();
  const byLocaleSlug = new Map<string, string>();
  const errors: string[] = [];

  for (const post of posts) {
    const articleKey = `${post.articleId}:${post.locale}`;
    const slugKey = `${post.locale}:${post.slug}`;
    const sameArticle = byArticleLocale.get(articleKey);
    if (sameArticle) {
      errors.push(
        `Duplicate articleId + locale ${articleKey}: ${sameArticle} and ${post.sourcePath}`,
      );
    }
    const sameSlug = byLocaleSlug.get(slugKey);
    if (sameSlug) {
      errors.push(
        `Duplicate locale + slug ${slugKey}: ${sameSlug} and ${post.sourcePath}`,
      );
    }
    byArticleLocale.set(articleKey, post.sourcePath);
    byLocaleSlug.set(slugKey, post.sourcePath);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function normalizeSlug(value: string) {
  const slug = value.replace(/^\/+|\/+$/g, "");
  return !slug || /[/?#]/.test(slug) ? "" : slug;
}

function readDate(value: unknown, key: string, errors: string[]) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  // YAML reads an unquoted 2026-11-15 as a Date and a quoted one as a string.
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    errors.push(`${key} must be a date such as 2026-11-15`);
    return null;
  }
  return date;
}

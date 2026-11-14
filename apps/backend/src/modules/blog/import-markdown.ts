import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { renderMarkdownContent } from "./markdown-renderer";
import {
  parseMarkdownPost,
  validateMarkdownPosts,
  type ParsedMarkdownPost,
} from "./markdown-source";
import type { RenderedBlogContent } from "./notion-renderer";

/** One Markdown article as text, with the name it is reported under. */
export type MarkdownFile = { path: string; content: string };

export type PreparedMarkdownPost = {
  post: ParsedMarkdownPost;
  rendered: RenderedBlogContent;
};

/** Every problem found in a batch of Markdown articles, per file. */
export class MarkdownImportError extends Error {
  constructor(readonly problems: Array<{ path: string; message: string }>) {
    super(
      problems
        .map((problem) =>
          problem.path ? `${problem.path}: ${problem.message}` : problem.message,
        )
        .join("\n"),
    );
    this.name = "MarkdownImportError";
  }
}

export type ImportMarkdownBlogOptions = {
  dir: string;
  dryRun?: boolean;
  validateOnly?: boolean;
};

export type ImportMarkdownBlogResult = {
  scanned: number;
  validated: number;
  upserted: number;
  published: number;
  dryRun: boolean;
  validateOnly: boolean;
};

export type WriteMarkdownPostsOptions = {
  /**
   * Keep an existing post's status and publish date and only update its
   * content and fields. An edited article uploaded again then stays as public
   * (or as hidden) as it was; a new post takes the status in its file.
   */
  preserveExistingStatus?: boolean;
};

/**
 * Parse, render and cross-check a batch of Markdown articles without touching
 * the database. Throws one `MarkdownImportError` listing every problem, so a
 * bad file fails the batch before anything is written.
 */
export function prepareMarkdownPosts(
  files: MarkdownFile[],
): PreparedMarkdownPost[] {
  if (files.length === 0) {
    throw new MarkdownImportError([
      { path: "", message: "No Markdown files to import" },
    ]);
  }

  const problems: Array<{ path: string; message: string }> = [];
  const prepared: PreparedMarkdownPost[] = [];
  for (const file of files) {
    try {
      const post = parseMarkdownPost(file.content, file.path);
      prepared.push({ post, rendered: renderMarkdownContent(post.body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The parser prefixes its own message with the path; say it once.
      problems.push({
        path: file.path,
        message: message.startsWith(`${file.path}:`)
          ? message.slice(file.path.length + 1).trim()
          : message,
      });
    }
  }
  if (problems.length > 0) {
    throw new MarkdownImportError(problems);
  }

  try {
    validateMarkdownPosts(prepared.map((entry) => entry.post));
  } catch (error) {
    throw new MarkdownImportError(
      (error instanceof Error ? error.message : String(error))
        .split("\n")
        .map((message) => ({ path: "", message })),
    );
  }

  return prepared;
}

/** Write prepared articles to `blog_posts`, marked as Markdown-sourced. */
export async function writeMarkdownPosts(
  prepared: PreparedMarkdownPost[],
  options: WriteMarkdownPostsOptions = {},
) {
  // Loaded only when rows are written, so validating or dry-running a batch
  // needs no database connection.
  const {
    BLOG_SOURCE_MARKDOWN,
    buildBlogPostId,
    getBlogPostStates,
    upsertBlogPost,
  } = await import("./repository");

  const ids = prepared.map(({ post }) =>
    buildBlogPostId(post.articleId, post.locale),
  );
  const existing = options.preserveExistingStatus
    ? await getBlogPostStates(ids)
    : new Map<string, never>();

  const written: Array<{ id: string; created: boolean }> = [];
  for (const [index, { post, rendered }] of prepared.entries()) {
    const id = ids[index]!;
    const current = existing.get(id);
    await upsertBlogPost({
      id,
      articleId: post.articleId,
      locale: post.locale,
      slug: post.slug,
      // The status alone decides visibility for a Markdown article.
      syncEnabled: true,
      status: current?.status ?? post.status,
      title: post.title,
      excerpt: post.excerpt,
      contentHtml: rendered.contentHtml,
      contentText: rendered.contentText,
      readingTimeMinutes: rendered.readingTimeMinutes,
      seoTitle: post.seoTitle,
      seoDescription: post.seoDescription,
      canonicalUrl: post.canonicalUrl,
      ogImageAssetId: null,
      coverAssetId: null,
      authorName: post.authorName,
      category: post.category,
      tags: post.tags,
      featured: post.featured,
      featuredStartsAt: null,
      publishedAt: current ? current.publishedAt : post.publishedAt,
      updatedAt: post.updatedAt,
      sourceLastEditedAt: null,
      contentHash: rendered.contentHash,
      metadataJson: {
        source: BLOG_SOURCE_MARKDOWN,
        source_path_hash: createHash("sha256")
          .update(post.sourcePath)
          .digest("hex"),
        tags: post.tags,
      },
    });
    written.push({ id, created: !current });
  }

  return written;
}

/**
 * Publish articles from a directory of Markdown files, the second way into
 * `blog_posts` beside the Notion sync. A post absent from the directory is
 * left as it is: unpublishing is done by setting `status` in its file.
 */
export async function importMarkdownBlog(
  options: ImportMarkdownBlogOptions,
): Promise<ImportMarkdownBlogResult> {
  const dryRun = Boolean(options.dryRun);
  const validateOnly = Boolean(options.validateOnly);
  const paths = await listMarkdownFiles(options.dir);
  if (paths.length === 0) {
    throw new Error(`No .md files found under ${options.dir}`);
  }

  const prepared = prepareMarkdownPosts(
    await Promise.all(
      paths.map(async (path) => ({
        path: relative(options.dir, path),
        content: await readFile(path, "utf8"),
      })),
    ),
  );

  const result: ImportMarkdownBlogResult = {
    scanned: paths.length,
    validated: prepared.length,
    upserted: 0,
    published: prepared.filter((entry) => entry.post.status === "published")
      .length,
    dryRun,
    validateOnly,
  };
  if (validateOnly) {
    return result;
  }
  if (dryRun) {
    result.upserted = prepared.length;
    return result;
  }

  result.upserted = (await writeMarkdownPosts(prepared)).length;
  return result;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { renderMarkdownContent } from "./markdown-renderer";
import {
  parseMarkdownPost,
  validateMarkdownPosts,
  type ParsedMarkdownPost,
} from "./markdown-source";

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

/**
 * Publish articles from Markdown files, the second way into `blog_posts`
 * beside the Notion sync. Every file is parsed, rendered and cross-checked
 * before the first row is written, so a bad file fails the run with nothing
 * changed. A post absent from the directory is left as it is: unpublishing is
 * done by setting `status` in its file.
 */
export async function importMarkdownBlog(
  options: ImportMarkdownBlogOptions,
): Promise<ImportMarkdownBlogResult> {
  const dryRun = Boolean(options.dryRun);
  const validateOnly = Boolean(options.validateOnly);
  const files = await listMarkdownFiles(options.dir);
  if (files.length === 0) {
    throw new Error(`No .md files found under ${options.dir}`);
  }

  const errors: string[] = [];
  const prepared: Array<{
    post: ParsedMarkdownPost;
    rendered: ReturnType<typeof renderMarkdownContent>;
  }> = [];
  for (const file of files) {
    const sourcePath = relative(options.dir, file);
    try {
      const post = parseMarkdownPost(await readFile(file, "utf8"), sourcePath);
      prepared.push({ post, rendered: renderMarkdownContent(post.body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message.startsWith(sourcePath) ? message : `${sourcePath}: ${message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  validateMarkdownPosts(prepared.map((entry) => entry.post));

  const result: ImportMarkdownBlogResult = {
    scanned: files.length,
    validated: prepared.length,
    upserted: 0,
    published: prepared.filter((entry) => entry.post.status === "published")
      .length,
    dryRun,
    validateOnly,
  };
  if (validateOnly || dryRun) {
    result.upserted = validateOnly ? 0 : prepared.length;
    return result;
  }

  // Loaded only when rows are written, so validating or dry-running a folder
  // of articles needs no database connection.
  const { BLOG_SOURCE_MARKDOWN, buildBlogPostId, upsertBlogPost } =
    await import("./repository");

  for (const { post, rendered } of prepared) {
    await upsertBlogPost({
      id: buildBlogPostId(post.articleId, post.locale),
      articleId: post.articleId,
      locale: post.locale,
      slug: post.slug,
      // The file's status alone decides visibility for a Markdown article.
      syncEnabled: true,
      status: post.status,
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
      publishedAt: post.publishedAt,
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
    result.upserted += 1;
  }

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

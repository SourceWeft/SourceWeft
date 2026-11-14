import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  importBlogMarkdownRequestSchema,
  setBlogAdminPostStatusRequestSchema,
  type BlogAdminPost,
  type BlogAdminPostDetail,
  type ImportBlogMarkdownResponse,
  type ListBlogAdminPostsResponse,
} from "@sourceweft/contracts";
import {
  MarkdownImportError,
  prepareMarkdownPosts,
  writeMarkdownPosts,
} from "../../modules/blog/import-markdown";
import {
  getBlogPostForAdmin,
  listBlogPostsForAdmin,
  setBlogPostStatus,
} from "../../modules/blog/repository";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";

/**
 * The admin's blog screen: list every post, preview one, import Markdown
 * articles, and publish or unpublish. Admins are the market admins for now;
 * every route checks on its own.
 */

const BASE = "/v1/blog/admin";

async function body<Schema extends z.ZodTypeAny>(
  c: Context,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const raw = await c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

type PostRow = NonNullable<Awaited<ReturnType<typeof getBlogPostForAdmin>>>;

function toPost(row: Omit<PostRow, "contentHtml">): BlogAdminPost {
  return {
    id: row.id,
    articleId: row.articleId,
    locale: row.locale,
    slug: row.slug,
    status: row.status,
    syncEnabled: row.syncEnabled,
    title: row.title,
    excerpt: row.excerpt,
    category: row.category,
    tags: row.tags,
    readingTimeMinutes: row.readingTimeMinutes,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    syncedAt: row.syncedAt.toISOString(),
    source: row.source,
  };
}

function toDetail(row: PostRow): BlogAdminPostDetail {
  return { ...toPost(row), contentHtml: row.contentHtml ?? "" };
}

function postId(c: Context) {
  return decodeURIComponent(c.req.param("id") ?? "");
}

export function registerBlogAdminRoutes(app: Hono) {
  app.get(`${BASE}/posts`, async (c) => {
    await requireSkillMarketAdmin(c);
    const rows = await listBlogPostsForAdmin();
    return ApiResponse.success<ListBlogAdminPostsResponse>(c, {
      items: rows.map(toPost),
    });
  });

  app.get(`${BASE}/posts/:id`, async (c) => {
    await requireSkillMarketAdmin(c);
    const row = await getBlogPostForAdmin(postId(c));
    if (!row) throw ApiError.notFound("Post not found");
    return ApiResponse.success(c, toDetail(row));
  });

  app.post(`${BASE}/posts/:id/status`, async (c) => {
    await requireSkillMarketAdmin(c);
    const input = await body(c, setBlogAdminPostStatusRequestSchema);
    const row = await setBlogPostStatus({ id: postId(c), status: input.status });
    if (!row) throw ApiError.notFound("Post not found");
    return ApiResponse.success(c, toDetail(row));
  });

  app.post(`${BASE}/import`, async (c) => {
    await requireSkillMarketAdmin(c);
    const input = await body(c, importBlogMarkdownRequestSchema);
    const dryRun = Boolean(input.dryRun);

    let prepared: ReturnType<typeof prepareMarkdownPosts>;
    try {
      prepared = prepareMarkdownPosts(input.files);
    } catch (error) {
      if (error instanceof MarkdownImportError) {
        throw ApiError.validation({ problems: error.problems });
      }
      throw error;
    }

    // An upload never changes whether an existing article is public: its
    // status and publish date stay, and only a new post takes its file's.
    const written = dryRun
      ? null
      : await writeMarkdownPosts(prepared, { preserveExistingStatus: true });

    return ApiResponse.success<ImportBlogMarkdownResponse>(c, {
      dryRun,
      posts: prepared.map(({ post }, index) => ({
        path: post.sourcePath,
        articleId: post.articleId,
        locale: post.locale,
        slug: post.slug,
        title: post.title,
        created: written?.[index]?.created ?? false,
      })),
    });
  });
}

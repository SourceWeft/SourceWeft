import { z } from "zod";

/**
 * The admin's blog screen: every article in every language with its status,
 * one article's rendered body for preview, importing Markdown files, and
 * publishing or unpublishing. All routes are under `/v1/blog/admin` and answer
 * 403 to anyone who is not an admin.
 */

export const blogAdminPostStatusSchema = z.enum([
  "draft",
  "published",
  "archived",
]);
export type BlogAdminPostStatus = z.infer<typeof blogAdminPostStatusSchema>;

export const blogAdminPostSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  locale: z.string(),
  slug: z.string(),
  status: blogAdminPostStatusSchema,
  // False hides a post regardless of status (a Notion row with Sync off).
  syncEnabled: z.boolean(),
  title: z.string(),
  excerpt: z.string(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  readingTimeMinutes: z.number(),
  publishedAt: z.string().nullable(),
  // When the row was last written by an import or a sync.
  syncedAt: z.string(),
  source: z.enum(["markdown", "notion"]),
});
export type BlogAdminPost = z.infer<typeof blogAdminPostSchema>;

// GET /v1/blog/admin/posts
export const listBlogAdminPostsResponseSchema = z.object({
  items: z.array(blogAdminPostSchema),
});
export type ListBlogAdminPostsResponse = z.infer<
  typeof listBlogAdminPostsResponseSchema
>;

// GET /v1/blog/admin/posts/:id
export const blogAdminPostDetailSchema = blogAdminPostSchema.extend({
  contentHtml: z.string(),
});
export type BlogAdminPostDetail = z.infer<typeof blogAdminPostDetailSchema>;

// POST /v1/blog/admin/posts/:id/status
export const setBlogAdminPostStatusRequestSchema = z.object({
  status: blogAdminPostStatusSchema,
});
export type SetBlogAdminPostStatusRequest = z.infer<
  typeof setBlogAdminPostStatusRequestSchema
>;

// POST /v1/blog/admin/import
export const importBlogMarkdownRequestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        content: z.string().min(1).max(400_000),
      }),
    )
    .min(1)
    .max(100),
  // Validate and render only; nothing is written.
  dryRun: z.boolean().optional(),
});
export type ImportBlogMarkdownRequest = z.infer<
  typeof importBlogMarkdownRequestSchema
>;

export const importBlogMarkdownResponseSchema = z.object({
  dryRun: z.boolean(),
  // One entry per file, in upload order.
  posts: z.array(
    z.object({
      path: z.string(),
      articleId: z.string(),
      locale: z.string(),
      slug: z.string(),
      title: z.string(),
      // False when the import updated a post that already existed, whose
      // status and publish date were kept.
      created: z.boolean(),
    }),
  ),
});
export type ImportBlogMarkdownResponse = z.infer<
  typeof importBlogMarkdownResponseSchema
>;

// The `details` of the 400 an invalid import answers with.
export const importBlogMarkdownProblemsSchema = z.object({
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type ImportBlogMarkdownProblems = z.infer<
  typeof importBlogMarkdownProblemsSchema
>;

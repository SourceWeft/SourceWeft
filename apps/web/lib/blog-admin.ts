import type {
  BlogAdminPostDetail,
  BlogAdminPostStatus,
  ImportBlogMarkdownProblems,
  ImportBlogMarkdownResponse,
  ListBlogAdminPostsResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * The admin's blog screen: every post, one post's rendered body, importing
 * Markdown articles, and publishing. Every route answers 403 to anyone who is
 * not an admin.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

const BASE = "/v1/blog/admin";

export function listBlogAdminPosts() {
  return http.get<ListBlogAdminPostsResponse>(`${BASE}/posts`);
}

export function getBlogAdminPost(id: string) {
  return http.get<BlogAdminPostDetail>(
    `${BASE}/posts/${encodeURIComponent(id)}`,
  );
}

export function setBlogAdminPostStatus(id: string, status: BlogAdminPostStatus) {
  return http.post<BlogAdminPostDetail>(
    `${BASE}/posts/${encodeURIComponent(id)}/status`,
    { status },
  );
}

export function importBlogMarkdown(
  files: Array<{ path: string; content: string }>,
) {
  return http.post<ImportBlogMarkdownResponse>(`${BASE}/import`, { files });
}

/** The per-file problems of a refused import, when the error carries them. */
export function importProblems(
  error: unknown,
): ImportBlogMarkdownProblems["problems"] | null {
  const problems = (error as { details?: { problems?: unknown } } | null)
    ?.details?.problems;
  if (!Array.isArray(problems)) return null;
  return problems.filter(
    (problem): problem is { path: string; message: string } =>
      typeof problem?.path === "string" && typeof problem?.message === "string",
  );
}

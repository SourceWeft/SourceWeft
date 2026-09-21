import type {
  DeleteSkillReviewResponse,
  ListSkillReviewsResponse,
  SetSkillReviewStatusResponse,
  SkillMarketAdminMeResponse,
  SkillReview,
  SkillReviewResponse,
  SkillReviewSort,
  SkillReviewStatus,
  SkillReviewSummary,
  SkillReviewViewer,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * Ratings and reviews of market skills (§17.3). Keyed by slug, which is
 * unique across skills, so the dashboard and the public page share the
 * routes. The list reads the session when there is one: it then also says
 * whether the viewer may review or reply, and carries their own review.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

export type {
  ListSkillReviewsResponse,
  SkillReview,
  SkillReviewSort,
  SkillReviewStatus,
  SkillReviewSummary,
  SkillReviewViewer,
};

export const SKILL_REVIEW_SORTS: readonly SkillReviewSort[] = [
  "newest",
  "highest",
  "lowest",
];

function reviewsPath(slug: string) {
  return `/v1/skills/${encodeURIComponent(slug)}/reviews`;
}

function replyPath(slug: string, reviewId: string) {
  return `${reviewsPath(slug)}/${encodeURIComponent(reviewId)}/reply`;
}

/** The query string of a page request; empty values are left out. */
export function skillReviewsQuery(input: {
  sort?: SkillReviewSort;
  cursor?: string | null;
  limit?: number;
}): string {
  const params = new URLSearchParams();
  if (input.sort) params.set("sort", input.sort);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function listSkillReviews(
  slug: string,
  input: {
    sort?: SkillReviewSort;
    cursor?: string | null;
    limit?: number;
  } = {},
) {
  return http.get<ListSkillReviewsResponse>(
    `${reviewsPath(slug)}${skillReviewsQuery(input)}`,
  );
}

export function saveMySkillReview(
  slug: string,
  input: { rating: number; body: string },
) {
  return http.put<SkillReviewResponse>(`${reviewsPath(slug)}/mine`, {
    rating: input.rating,
    body: input.body,
  });
}

export function deleteMySkillReview(slug: string) {
  return http.delete<DeleteSkillReviewResponse>(`${reviewsPath(slug)}/mine`);
}

export function saveSkillReviewReply(
  slug: string,
  reviewId: string,
  body: string,
) {
  return http.put<SkillReviewResponse>(replyPath(slug, reviewId), { body });
}

export function deleteSkillReviewReply(slug: string, reviewId: string) {
  return http.delete<SkillReviewResponse>(replyPath(slug, reviewId));
}

/** A market admin hides a review, or shows it again. */
export function setSkillReviewStatus(
  reviewId: string,
  status: SkillReviewStatus,
) {
  return http.post<SetSkillReviewStatusResponse>(
    `/v1/skills/registry/admin/reviews/${encodeURIComponent(reviewId)}/status`,
    { status },
  );
}

/**
 * Whether to show the market admin's controls. The answer grants nothing —
 * every admin route checks for itself — so any failure reads as "no".
 */
export async function isSkillMarketAdminViewer(): Promise<boolean> {
  try {
    const me = await http.get<SkillMarketAdminMeResponse>(
      "/v1/skills/registry/admin/me",
    );
    return me.isMarketAdmin === true;
  } catch {
    return false;
  }
}

export type SkillReviewErrorKind =
  "rate_limited" | "not_installed" | "forbidden" | "not_found" | "other";

/** What went wrong with a review call, from the status and error code. */
export function skillReviewErrorKind(error: unknown): SkillReviewErrorKind {
  const { status, code } = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
  };
  if (status === 429 || code === "SKILL_REVIEW_RATE_LIMITED") {
    return "rate_limited";
  }
  if (code === "SKILL_REVIEW_NOT_INSTALLED") return "not_installed";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "other";
}

/**
 * The next page appended to what is shown. A review already on screen — one
 * that moved while paging, say after an edit — is not shown twice.
 */
export function appendSkillReviews(
  shown: SkillReview[],
  next: SkillReview[],
): SkillReview[] {
  const seen = new Set(shown.map((review) => review.id));
  return [...shown, ...next.filter((review) => !seen.has(review.id))];
}

import { z } from "zod";

/**
 * Ratings and reviews of market skills (§17.3). One review per person per
 * skill, editable; only someone whose workspace installed the skill may write
 * one. The repository's claimed author may answer each review once, and a
 * market admin may hide a review, which takes it out of every count.
 */

export const SKILL_REVIEW_BODY_MAX_LENGTH = 2000;
export const SKILL_REVIEWS_DEFAULT_PAGE_SIZE = 20;
export const SKILL_REVIEWS_MAX_PAGE_SIZE = 50;

export const skillReviewRatingSchema = z.number().int().min(1).max(5);

/**
 * Plain text, trimmed. NUL is dropped rather than refused: PostgreSQL cannot
 * store it in `text`, and nobody typed it on purpose.
 */
const reviewTextSchema = z
  .string()
  .transform((value) => value.replaceAll("\u0000", "").trim())
  .pipe(z.string().max(SKILL_REVIEW_BODY_MAX_LENGTH));

export const skillReviewSortSchema = z.enum(["newest", "highest", "lowest"]);
export type SkillReviewSort = z.infer<typeof skillReviewSortSchema>;

export const skillReviewStatusSchema = z.enum(["visible", "hidden"]);
export type SkillReviewStatus = z.infer<typeof skillReviewStatusSchema>;

// GET /v1/skills/:slug/reviews
export const listSkillReviewsRequestSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SKILL_REVIEWS_MAX_PAGE_SIZE)
    .default(SKILL_REVIEWS_DEFAULT_PAGE_SIZE),
  sort: skillReviewSortSchema.default("newest"),
});
export type ListSkillReviewsRequest = z.infer<
  typeof listSkillReviewsRequestSchema
>;

// PUT /v1/skills/:slug/reviews/mine — creates or replaces the caller's review.
export const upsertSkillReviewRequestSchema = z
  .object({
    rating: skillReviewRatingSchema,
    body: reviewTextSchema.default(""),
  })
  .strict();
export type UpsertSkillReviewRequest = z.infer<
  typeof upsertSkillReviewRequestSchema
>;

// PUT /v1/skills/:slug/reviews/:reviewId/reply
export const setSkillReviewReplyRequestSchema = z
  .object({
    body: reviewTextSchema.pipe(z.string().min(1)),
  })
  .strict();
export type SetSkillReviewReplyRequest = z.infer<
  typeof setSkillReviewReplyRequestSchema
>;

// POST /v1/skills/registry/admin/reviews/:reviewId/status
export const setSkillReviewStatusRequestSchema = z
  .object({
    status: skillReviewStatusSchema,
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();
export type SetSkillReviewStatusRequest = z.infer<
  typeof setSkillReviewStatusRequestSchema
>;

export const skillReviewSchema = z.object({
  id: z.string(),
  rating: skillReviewRatingSchema,
  body: z.string(),
  // Always `visible` in a public list; `hidden` only on the author's own
  // review, which they still see after a market admin hid it.
  status: skillReviewStatusSchema,
  // The skill's version when the review was last written; null once that
  // version is gone.
  version: z.string().nullable(),
  // A name and an avatar, never a user id. Null for someone who left.
  reviewer: z.object({
    name: z.string().nullable(),
    image: z.string().nullable(),
  }),
  authorReply: z.object({ body: z.string(), createdAt: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillReview = z.infer<typeof skillReviewSchema>;

/** Over visible reviews only, computed when asked. */
export const skillReviewSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  // Null while there are no visible reviews.
  average: z.number().nullable(),
  distribution: z.object({
    "1": z.number().int().nonnegative(),
    "2": z.number().int().nonnegative(),
    "3": z.number().int().nonnegative(),
    "4": z.number().int().nonnegative(),
    "5": z.number().int().nonnegative(),
  }),
});
export type SkillReviewSummary = z.infer<typeof skillReviewSummarySchema>;

export const skillReviewViewerSchema = z.object({
  canReview: z.boolean(),
  // Why not, when `canReview` is false.
  reason: z.enum(["signed_out", "not_installed"]).optional(),
  // The viewer holds the verified claim on the skill's repository, so may
  // answer reviews.
  canReply: z.boolean(),
  ownReview: skillReviewSchema.optional(),
});
export type SkillReviewViewer = z.infer<typeof skillReviewViewerSchema>;

export const listSkillReviewsResponseSchema = z.object({
  items: z.array(skillReviewSchema),
  nextCursor: z.string().nullable(),
  summary: skillReviewSummarySchema,
  viewer: skillReviewViewerSchema,
});
export type ListSkillReviewsResponse = z.infer<
  typeof listSkillReviewsResponseSchema
>;

export const skillReviewResponseSchema = z.object({
  review: skillReviewSchema,
});
export type SkillReviewResponse = z.infer<typeof skillReviewResponseSchema>;

export const deleteSkillReviewResponseSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteSkillReviewResponse = z.infer<
  typeof deleteSkillReviewResponseSchema
>;

export const setSkillReviewStatusResponseSchema = z.object({
  reviewId: z.string(),
  skillId: z.string(),
  status: skillReviewStatusSchema,
});
export type SetSkillReviewStatusResponse = z.infer<
  typeof setSkillReviewStatusResponseSchema
>;

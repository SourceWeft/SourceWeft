import { z } from "zod";

/**
 * Reports about market skills and reviews (skill-marketplace-plan §17.2).
 * Anyone may tell the market admins a skill, or one review of it, is wrong —
 * a visitor without an account too, as long as they leave an address to
 * answer. A report never changes the skill by itself: an admin decides.
 */

export const skillReportReasonSchema = z.enum([
  "copyright",
  "malicious",
  "impersonation",
  "spam",
  "broken",
  "other",
]);
export type SkillReportReason = z.infer<typeof skillReportReasonSchema>;

export const skillReportStatusSchema = z.enum([
  "open",
  "actioned",
  "dismissed",
]);
export type SkillReportStatus = z.infer<typeof skillReportStatusSchema>;

export const SKILL_REPORT_DETAILS_MAX_LENGTH = 4000;

/** A field left empty in a form was not given. */
const blankAsMissing = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// POST /v1/skills/:slug/reports — `contactEmail` is required of a visitor who
// is not signed in; the route checks that, since the body cannot know.
export const createSkillReportRequestSchema = z
  .object({
    reason: skillReportReasonSchema,
    details: z
      .string()
      .trim()
      .max(SKILL_REPORT_DETAILS_MAX_LENGTH)
      .optional()
      .default(""),
    contactEmail: z.preprocess(
      blankAsMissing,
      z.string().trim().email().max(320).optional(),
    ),
    // The report is about this review of the skill, not the skill itself.
    reviewId: z.preprocess(
      blankAsMissing,
      z.string().trim().min(1).max(128).optional(),
    ),
  })
  .strict();
export type CreateSkillReportRequest = z.infer<
  typeof createSkillReportRequestSchema
>;

// Deliberately little: the reporter learns it was received, nothing about
// other reports or what an admin will do.
export const createSkillReportResponseSchema = z.object({
  id: z.string(),
  status: z.literal("open"),
  createdAt: z.string(),
});
export type CreateSkillReportResponse = z.infer<
  typeof createSkillReportResponseSchema
>;

// --- Admin queue -------------------------------------------------------------

export const listSkillReportsRequestSchema = z.object({
  status: skillReportStatusSchema.default("open"),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListSkillReportsRequest = z.infer<
  typeof listSkillReportsRequestSchema
>;

export const skillReportItemSchema = z.object({
  id: z.string(),
  reason: skillReportReasonSchema,
  details: z.string(),
  status: skillReportStatusSchema,
  createdAt: z.string(),
  resolution: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  skill: z.object({
    id: z.string(),
    slug: z.string(),
    displayName: z.string(),
    visibility: z.string(),
    listingHold: z.boolean(),
  }),
  // Set when the report is about one review.
  review: z
    .object({
      id: z.string(),
      rating: z.number().int(),
      // The start of the review's text.
      excerpt: z.string(),
      status: z.enum(["visible", "hidden"]),
    })
    .nullable(),
  reporter: z.object({
    // Null for a visitor who was not signed in.
    userId: z.string().nullable(),
    // The account's name, its id when it has none, or "anonymous".
    displayName: z.string(),
    // The address the reporter left with the report.
    contactEmail: z.string().nullable(),
    // A signed-in reporter's account address, for answering them.
    accountEmail: z.string().nullable(),
  }),
  // Other reports on the same skill still waiting for an admin.
  otherOpenReports: z.number().int().nonnegative(),
});
export type SkillReportItem = z.infer<typeof skillReportItemSchema>;

export const listSkillReportsResponseSchema = z.object({
  items: z.array(skillReportItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListSkillReportsResponse = z.infer<
  typeof listSkillReportsResponseSchema
>;

/**
 * What an admin does about a report. Granting a claim (common for copyright)
 * is its own admin route; `none` closes the report after acting elsewhere.
 */
export const skillReportActionSchema = z.enum([
  "dismiss",
  "withdraw_skill",
  "revoke_version",
  "hide_review",
  "none",
]);
export type SkillReportAction = z.infer<typeof skillReportActionSchema>;

// POST /v1/skills/registry/admin/reports/:reportId/resolve
export const resolveSkillReportRequestSchema = z
  .object({
    action: skillReportActionSchema,
    resolution: z.string().trim().max(1000).optional(),
    // Close the other open reports on the same skill (or the same review)
    // with the same decision.
    alsoResolveSameTarget: z.boolean().optional(),
  })
  .strict();
export type ResolveSkillReportRequest = z.infer<
  typeof resolveSkillReportRequestSchema
>;

export const resolveSkillReportResponseSchema = z.object({
  reportId: z.string(),
  status: z.enum(["actioned", "dismissed"]),
  action: skillReportActionSchema,
  // Every report this decision closed, `reportId` first.
  resolvedReportIds: z.array(z.string()),
});
export type ResolveSkillReportResponse = z.infer<
  typeof resolveSkillReportResponseSchema
>;

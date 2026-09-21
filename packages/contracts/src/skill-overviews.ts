import { z } from "zod";

/**
 * AI overviews of market skills and the market settings behind them
 * (skill-marketplace-plan §17.4). The public market's read side (the
 * `aiSummary`/`aiOverview` fields and the `locale` query) lives in
 * `@sourceweft/market-contracts`; this file is the market admin's side.
 */

export const skillOverviewLocaleSchema = z.enum(["en", "zh-CN", "zh-TW"]);

// One version's overview in one language. Plain text, written by a model from
// third-party content: render it as untrusted text, never as HTML.
export const skillOverviewContentSchema = z.object({
  // One sentence, for cards.
  summary: z.string(),
  whatItDoes: z.string(),
  whenToUse: z.string(),
  // Dependencies, scripts and credentials it needs; "" when none.
  requirements: z.string(),
  // Market category slugs the model suggested (0–2).
  suggestedCategories: z.array(z.string()),
});

// The team, workspace and member the overviews' model calls are billed to.
// Overviews are not generated while this is unset.
export const skillOverviewBillingSchema = z.object({
  teamId: z.string().min(1),
  workspaceId: z.string().min(1),
  // The member of that team whose allocation pays: the admin who set it,
  // unless they named another member.
  userId: z.string().min(1),
});

// GET/PUT /v1/skills/registry/admin/settings/overview-billing
export const getSkillOverviewBillingResponseSchema = z.object({
  billing: skillOverviewBillingSchema.nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const putSkillOverviewBillingRequestSchema = z.object({
  teamId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200),
  // Defaults to the admin making the change; must be a member of the
  // workspace either way.
  userId: z.string().trim().min(1).max(200).optional(),
});

// GET /v1/skills/registry/admin/skills/:skillId/overview
export const skillOverviewAdminEntrySchema = z.object({
  locale: skillOverviewLocaleSchema,
  overview: skillOverviewContentSchema,
  model: z.string(),
  hidden: z.boolean(),
  generatedAt: z.string(),
});

export const getSkillOverviewAdminResponseSchema = z.object({
  skillId: z.string(),
  // The current published version; null when the skill has none.
  skillVersionId: z.string().nullable(),
  bundleSha256: z.string().nullable(),
  // Whether the skill is one overviews are written for (public, active,
  // imported from GitHub).
  eligible: z.boolean(),
  overviews: z.array(skillOverviewAdminEntrySchema),
});

// POST /v1/skills/registry/admin/skills/:skillId/overview/regenerate
export const regenerateSkillOverviewResponseSchema = z.object({
  skillId: z.string(),
  skillVersionId: z.string(),
  // Rows removed before the new job was queued.
  deleted: z.number().int().nonnegative(),
  queued: z.boolean(),
});

// POST /v1/skills/registry/admin/skills/:skillId/overview/visibility
export const setSkillOverviewVisibilityRequestSchema = z.object({
  hidden: z.boolean(),
});

export const setSkillOverviewVisibilityResponseSchema = z.object({
  skillId: z.string(),
  skillVersionId: z.string(),
  hidden: z.boolean(),
  // Locales changed.
  updated: z.number().int().nonnegative(),
});

// GET /v1/skills/registry/admin/overviews/status
export const skillOverviewStatusResponseSchema = z.object({
  billingConfigured: z.boolean(),
  // Public, active GitHub skills with a current published version.
  eligible: z.number().int().nonnegative(),
  withOverview: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
});

export type SkillOverviewLocale = z.infer<typeof skillOverviewLocaleSchema>;
export type SkillOverviewContent = z.infer<typeof skillOverviewContentSchema>;
export type SkillOverviewBilling = z.infer<typeof skillOverviewBillingSchema>;
export type GetSkillOverviewBillingResponse = z.infer<
  typeof getSkillOverviewBillingResponseSchema
>;
export type PutSkillOverviewBillingRequest = z.infer<
  typeof putSkillOverviewBillingRequestSchema
>;
export type SkillOverviewAdminEntry = z.infer<
  typeof skillOverviewAdminEntrySchema
>;
export type GetSkillOverviewAdminResponse = z.infer<
  typeof getSkillOverviewAdminResponseSchema
>;
export type RegenerateSkillOverviewResponse = z.infer<
  typeof regenerateSkillOverviewResponseSchema
>;
export type SetSkillOverviewVisibilityRequest = z.infer<
  typeof setSkillOverviewVisibilityRequestSchema
>;
export type SetSkillOverviewVisibilityResponse = z.infer<
  typeof setSkillOverviewVisibilityResponseSchema
>;
export type SkillOverviewStatusResponse = z.infer<
  typeof skillOverviewStatusResponseSchema
>;

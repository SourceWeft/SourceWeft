import { z } from "zod";

/**
 * The skill market's audit trail and the market admin's own screens
 * (skill-marketplace-plan §17.1): who is a market admin, every community skill
 * in one list, what happened to a skill and who did it, and re-inferring
 * categories.
 */

// --- Who is a market admin ------------------------------------------------

// GET /v1/skills/registry/admin/me — any signed-in user (401 signed out). The
// web shows the market admin's entry points only when this says so; every
// admin route still checks on its own.
export const skillMarketAdminMeResponseSchema = z.object({
  isMarketAdmin: z.boolean(),
});
export type SkillMarketAdminMeResponse = z.infer<
  typeof skillMarketAdminMeResponseSchema
>;

// --- Audit trail ----------------------------------------------------------

export const skillMarketEventActorKindSchema = z.enum([
  "admin",
  "owner",
  "user",
  "system",
]);
export type SkillMarketEventActorKind = z.infer<
  typeof skillMarketEventActorKindSchema
>;

/**
 * The actions recorded, for the web's labels. `action` itself stays a string
 * so an older web renders a newer action as its raw name instead of failing.
 */
export const SKILL_MARKET_EVENT_ACTIONS = [
  "listing.listed",
  "listing.withdrawn",
  "listing.auto_listed",
  "listing.owner_allowed",
  "listing.owner_private",
  "listing.kept",
  "verified.set",
  "verified.cleared",
  "featured.set",
  "categories.set",
  "categories.reinferred",
  "provenance.withheld",
  "claim.granted",
  "claim.revoked",
  "claim.removed",
  "claim.restored",
  "version.published",
  "version.rejected",
  "version.revoked",
  "review.written",
  "review.deleted",
  "review.replied",
  "review.reply_removed",
  "review.hidden",
  "review.shown",
  "report.actioned",
  "report.dismissed",
  "overview.regenerated",
  "overview.hidden",
  "overview.shown",
  "settings.updated",
] as const;
export type SkillMarketEventAction =
  (typeof SKILL_MARKET_EVENT_ACTIONS)[number];

export const skillMarketEventSchema = z.object({
  id: z.string(),
  // Null for an event about a repository as a whole (a claim) or about many
  // skills at once (a bulk re-inference).
  skillId: z.string().nullable(),
  // The skill as it is named now; null when there is no skill.
  skillSlug: z.string().nullable(),
  skillDisplayName: z.string().nullable(),
  // `owner/name`, for a repository-level event.
  repo: z.string().nullable(),
  actorKind: skillMarketEventActorKindSchema,
  // Null when the platform did it; `system:*` for a named platform pass.
  actorUserId: z.string().nullable(),
  // The actor's name now; null for the platform, or a user without a name.
  actorName: z.string().nullable(),
  action: z.string(),
  // Small and structured: `{ from, to }` pairs, version ids, a reason.
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type SkillMarketEvent = z.infer<typeof skillMarketEventSchema>;

// GET /v1/skills/registry/admin/skills/:skillId/events?limit= — newest first:
// the skill's own events and its repository's (claims).
// GET /v1/skills/registry/admin/events?cursor=&limit= — every event, newest
// first; `nextCursor` is null on the last page.
export const listSkillMarketEventsResponseSchema = z.object({
  items: z.array(skillMarketEventSchema),
  nextCursor: z.string().nullable(),
});
export type ListSkillMarketEventsResponse = z.infer<
  typeof listSkillMarketEventsResponseSchema
>;

export const SKILL_MARKET_EVENTS_DEFAULT_LIMIT = 50;
export const SKILL_MARKET_EVENTS_MAX_LIMIT = 200;

export const listSkillMarketEventsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SKILL_MARKET_EVENTS_MAX_LIMIT)
    .default(SKILL_MARKET_EVENTS_DEFAULT_LIMIT),
});

// --- Every community skill, for the admin ---------------------------------

// `public`: on the market. `restricted`: not public and not held — waiting on
// the platform's rules or the listing queue. `held`: an admin withdrew it.
// `owner_held`: its claimed author keeps it private.
export const skillMarketAdminStandingFilterSchema = z.enum([
  "public",
  "restricted",
  "held",
  "owner_held",
]);
export type SkillMarketAdminStandingFilter = z.infer<
  typeof skillMarketAdminStandingFilterSchema
>;

const booleanQuery = z.enum(["true", "false"]).transform((v) => v === "true");

export const SKILL_MARKET_ADMIN_SKILLS_DEFAULT_LIMIT = 50;
export const SKILL_MARKET_ADMIN_SKILLS_MAX_LIMIT = 100;

// GET /v1/skills/registry/admin/skills — query string. Each boolean filter is
// `true` or `false`; absent = either.
export const listSkillMarketAdminSkillsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  standing: skillMarketAdminStandingFilterSchema.optional(),
  featured: booleanQuery.optional(),
  verified: booleanQuery.optional(),
  claimed: booleanQuery.optional(),
  // The current version carries scan flags.
  flagged: booleanQuery.optional(),
  // Has open reports.
  reported: booleanQuery.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SKILL_MARKET_ADMIN_SKILLS_MAX_LIMIT)
    .default(SKILL_MARKET_ADMIN_SKILLS_DEFAULT_LIMIT),
});
export type ListSkillMarketAdminSkillsQuery = z.input<
  typeof listSkillMarketAdminSkillsQuerySchema
>;

export const skillMarketAdminSkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  // `owner/name`; null for a skill indexed before repositories were recorded.
  repo: z.string().nullable(),
  visibility: z.enum(["public", "restricted"]),
  listingHold: z.boolean(),
  listingHoldBy: z.enum(["admin", "owner"]).nullable(),
  featured: z.boolean(),
  verified: z.boolean(),
  claimed: z.boolean(),
  // Scan flags on the current version.
  flagCount: z.number().int().nonnegative(),
  openReportCount: z.number().int().nonnegative(),
  installCount: z.number().int().nonnegative(),
  ratingAvg: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type SkillMarketAdminSkill = z.infer<typeof skillMarketAdminSkillSchema>;

export const listSkillMarketAdminSkillsResponseSchema = z.object({
  items: z.array(skillMarketAdminSkillSchema),
  nextCursor: z.string().nullable(),
});
export type ListSkillMarketAdminSkillsResponse = z.infer<
  typeof listSkillMarketAdminSkillsResponseSchema
>;

// --- Re-inferring categories ----------------------------------------------

// POST /v1/skills/registry/admin/skills/:skillId/reinfer-categories answers
// with the skill's market standing (`skillMarketStandingWithClaimSchema`),
// its categories now inferred (`categoriesSetBy: "auto"`) even where an admin
// had picked them.
//
// POST /v1/skills/registry/admin/reinfer-categories — every community skill
// whose categories were inferred (never one an admin picked).
export const reinferSkillCategoriesResponseSchema = z.object({
  // Skills whose categories were inferred again.
  considered: z.number().int().nonnegative(),
  // Of those, the ones whose categories changed.
  changed: z.number().int().nonnegative(),
});
export type ReinferSkillCategoriesResponse = z.infer<
  typeof reinferSkillCategoriesResponseSchema
>;

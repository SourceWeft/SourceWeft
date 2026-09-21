import { z } from "zod";

/**
 * Sandbox run statistics of market skills (§17.5): how often a community
 * skill's scripts ran in SourceWeft sandboxes over the last 30 days, how often
 * they succeeded and what most often went wrong. Counts only — never a
 * command, an argument, a path or any output.
 */

/** The window the numbers cover. */
export const SKILL_RUN_STATS_WINDOW_DAYS = 30;
/**
 * Below these the public page shows nothing: a handful of runs, or runs from
 * one or two workspaces, would describe those workspaces rather than the skill.
 */
export const SKILL_RUN_STATS_MIN_RUNS = 10;
export const SKILL_RUN_STATS_MIN_WORKSPACES = 3;

export const skillRunErrorClassSchema = z.enum([
  "missing_dependency",
  "timeout",
  "permission",
  "other",
]);
export type SkillRunErrorClass = z.infer<typeof skillRunErrorClassSchema>;

export const skillRunTopErrorSchema = z.object({
  errorClass: skillRunErrorClassSchema,
  // The missing package or command for `missing_dependency`; null otherwise.
  subject: z.string().nullable(),
  count: z.number().int().nonnegative(),
});
export type SkillRunTopError = z.infer<typeof skillRunTopErrorSchema>;

// GET /v1/skills/:slug/run-stats — the public answer. `available: false` says
// nothing more, not even how far below the threshold the skill is.
export const skillRunStatsPublicSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    runs: z.number().int().nonnegative(),
    // 0..1
    successRate: z.number().min(0).max(1),
    workspaces: z.number().int().nonnegative(),
    topErrors: z.array(skillRunTopErrorSchema).max(5),
    windowDays: z.literal(SKILL_RUN_STATS_WINDOW_DAYS),
  }),
  z.object({ available: z.literal(false) }),
]);
export type SkillRunStatsPublic = z.infer<typeof skillRunStatsPublicSchema>;

// GET /v1/skills/:slug/run-stats?full=1 (the verified claimant) and
// GET /v1/skills/registry/admin/skills/:skillId/run-stats (market admins):
// the same numbers whatever their size.
export const skillRunStatsFullSchema = z.object({
  skillId: z.string(),
  runs: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  // Null while there are no runs.
  successRate: z.number().min(0).max(1).nullable(),
  workspaces: z.number().int().nonnegative(),
  topErrors: z.array(skillRunTopErrorSchema).max(5),
  windowDays: z.literal(SKILL_RUN_STATS_WINDOW_DAYS),
  // Whether the public page shows these numbers.
  publiclyVisible: z.boolean(),
  // When the scheduler last recomputed them; null if it never has.
  computedAt: z.string().nullable(),
});
export type SkillRunStatsFull = z.infer<typeof skillRunStatsFullSchema>;

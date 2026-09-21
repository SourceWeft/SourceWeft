import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * What "recommended" means, in one place: whose word stands behind a skill
 * first, then its rank score — how many workspaces keep it on and how many
 * people starred its repository, folded into one number — then how recently it
 * was listed.
 *
 * Three readers. The scheduler stores the score in
 * `skill_definitions.rank_score` (`refreshSkillInstallCounts`), so the catalog
 * can page by it. The catalog's `recommended` sort is the same ordering over
 * community skills alone — where only the verified/community step of the trust
 * ladder is left — written as ORDER BY in `catalog-query.ts`. The agent's
 * `search_skills` uses the comparator to order entries that fit the query
 * equally well. A database test holds the SQL and the comparator together.
 */

export type SkillRankSignals = {
  skillId: string;
  sourceType: string;
  /** A market admin's grant. Never self-asserted, so absent means false. */
  verified?: boolean;
  installCount?: number;
  /** GitHub stars of the repository the skill comes from; 0 when unknown. */
  repoStars?: number;
  /** ISO time the skill first went public; null or absent while unlisted. */
  listedAt?: string | null;
};

// The largest value the `integer` column holds. A score past it would fail the
// write, so it is capped instead.
const MAX_RANK_SCORE = 2_147_483_647;

/**
 * The rank score: `install_count * 100 + round(100 * ln(1 + repo_stars))`.
 *
 * An install is a workspace that chose to keep the skill on, which says more
 * about this skill than a star on its repository — a repository can ship fifty
 * skills and its stars are shared by all of them. So installs count linearly
 * and stars on a log scale: 10 stars are worth about 2.4 installs, 1,000 about
 * 6.9, 100,000 about 11.5. A popular repository lifts its skills above
 * unknown ones without burying skills that workspaces actually use.
 */
export function skillRankScore(input: {
  installCount?: number;
  repoStars?: number;
}): number {
  const installs = Math.max(0, Math.floor(input.installCount ?? 0));
  const stars = Math.max(0, Math.floor(input.repoStars ?? 0));
  return Math.min(
    MAX_RANK_SCORE,
    installs * 100 + Math.round(100 * Math.log1p(stars)),
  );
}

/**
 * The same formula over a `skill_definitions` row, for the scheduler's update.
 * PostgreSQL's `round` on a double rounds half away from zero, as `Math.round`
 * does for the non-negative values here.
 */
export const skillRankScoreSql: SQL<number> = sql<number>`least(${MAX_RANK_SCORE}::bigint, skill_definitions.install_count::bigint * 100 + round(100 * ln(1 + greatest(skill_definitions.repo_stars, 0)))::bigint)::int`;

/**
 * Lower is more trusted: ours, then what this workspace or its team wrote
 * themselves, then community skills a market admin vouched for, then the rest.
 */
export function skillTrustTier(
  skill: Pick<SkillRankSignals, "sourceType" | "verified">,
): number {
  if (skill.sourceType === "builtin") {
    return 0;
  }
  if (skill.sourceType !== "registry_github") {
    return 1;
  }
  return skill.verified ? 2 : 3;
}

function listedAtMs(listedAt: string | null | undefined): number {
  const ms = listedAt ? Date.parse(listedAt) : Number.NaN;
  // Never listed sorts as the oldest, as the SQL form reads NULL as the epoch.
  return Number.isNaN(ms) ? 0 : ms;
}

/** Sorts the more recommended skill first. Total: the id settles ties. */
export function compareRecommendedSkills(
  a: SkillRankSignals,
  b: SkillRankSignals,
): number {
  return (
    skillTrustTier(a) - skillTrustTier(b) ||
    skillRankScore(b) - skillRankScore(a) ||
    listedAtMs(b.listedAt) - listedAtMs(a.listedAt) ||
    (a.skillId < b.skillId ? 1 : a.skillId > b.skillId ? -1 : 0)
  );
}

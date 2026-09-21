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
 * community skills alone — where only the featured/verified/community steps of
 * the trust ladder are left — written as ORDER BY in `catalog-query.ts`. The agent's
 * `search_skills` uses the comparator to order entries that fit the query
 * equally well. A database test holds the SQL and the comparator together.
 */

export type SkillRankSignals = {
  skillId: string;
  sourceType: string;
  /** A market admin's grant. Never self-asserted, so absent means false. */
  verified?: boolean;
  /**
   * From a publisher the platform highlights, set by its own import or an
   * admin. Never self-asserted, so absent means false.
   */
  featured?: boolean;
  installCount?: number;
  /** GitHub stars of the repository the skill comes from; 0 when unknown. */
  repoStars?: number;
  /** Visible reviews (`skill_definitions.rating_count`). */
  ratingCount?: number;
  /** Their average rating; null or absent while there are none. */
  ratingAvg?: number | null;
  /** ISO time the skill first went public; null or absent while unlisted. */
  listedAt?: string | null;
};

// The largest value the `integer` column holds. A score past it would fail the
// write, so it is capped instead.
const MAX_RANK_SCORE = 2_147_483_647;

// The rating term (`skillRatingRankTerm`). A skill needs this many visible
// reviews before its rating counts at all; below it one or two friends of the
// author would be the whole signal.
export const RATING_RANK_MIN_REVIEWS = 5;
// The prior: every rating starts as if it already had `RATING_RANK_PRIOR_WEIGHT`
// reviews of `RATING_RANK_PRIOR_MEAN`, so a handful of fives lifts a skill a
// little and hundreds lift it all the way.
export const RATING_RANK_PRIOR_MEAN = 3.5;
export const RATING_RANK_PRIOR_WEIGHT = 5;
// Points per star away from the prior. Smoothed ratings stay within 1..5, so
// the term stays within -150..+90 — never as much as two installs.
export const RATING_RANK_WEIGHT = 60;

/**
 * Rounds half away from zero, as PostgreSQL's `round` on a double does.
 * `Math.round` rounds half up, which differs for negative halves.
 */
function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * What the rating adds to the rank score: 0 below `RATING_RANK_MIN_REVIEWS`
 * reviews, else `round(K * (smoothed - m))` where
 * `smoothed = (C * m + avg * n) / (C + n)` — a Bayesian average pulled toward
 * the prior `m` by `C` imaginary reviews. Positive for a skill rated above
 * the prior, negative below it. Small on purpose: whether workspaces keep a
 * skill on says more than what a few of their people wrote about it.
 */
export function skillRatingRankTerm(input: {
  ratingCount?: number;
  ratingAvg?: number | null;
}): number {
  const count = Math.floor(input.ratingCount ?? 0);
  const average = input.ratingAvg;
  if (
    count < RATING_RANK_MIN_REVIEWS ||
    average === null ||
    average === undefined ||
    !Number.isFinite(average)
  ) {
    return 0;
  }
  // Evaluated in the same order as the SQL below, so both sides compute the
  // same double.
  const smoothed =
    (RATING_RANK_PRIOR_WEIGHT * RATING_RANK_PRIOR_MEAN + average * count) /
    (RATING_RANK_PRIOR_WEIGHT + count);
  return roundHalfAwayFromZero(
    RATING_RANK_WEIGHT * (smoothed - RATING_RANK_PRIOR_MEAN),
  );
}

/**
 * The rank score: `install_count * 100 + round(100 * ln(1 + repo_stars))`,
 * plus the rating term, never below 0.
 *
 * An install is a workspace that chose to keep the skill on, which says more
 * about this skill than a star on its repository — a repository can ship fifty
 * skills and its stars are shared by all of them. So installs count linearly
 * and stars on a log scale: 10 stars are worth about 2.4 installs, 1,000 about
 * 6.9, 100,000 about 11.5. A popular repository lifts its skills above
 * unknown ones without burying skills that workspaces actually use. The
 * rating moves a skill by less than two installs either way
 * (`skillRatingRankTerm`). The floor keeps the score a valid cursor key: a
 * badly rated skill nobody uses ranks with the unrated ones, not below them.
 */
export function skillRankScore(input: {
  installCount?: number;
  repoStars?: number;
  ratingCount?: number;
  ratingAvg?: number | null;
}): number {
  const installs = Math.max(0, Math.floor(input.installCount ?? 0));
  const stars = Math.max(0, Math.floor(input.repoStars ?? 0));
  return Math.max(
    0,
    Math.min(
      MAX_RANK_SCORE,
      installs * 100 +
        Math.round(100 * Math.log1p(stars)) +
        skillRatingRankTerm(input),
    ),
  );
}

const ratingRankTermSql = sql`(case when skill_definitions.rating_count >= ${RATING_RANK_MIN_REVIEWS}::int and skill_definitions.rating_avg is not null then round(${RATING_RANK_WEIGHT}::float8 * ((${RATING_RANK_PRIOR_WEIGHT}::float8 * ${RATING_RANK_PRIOR_MEAN}::float8 + skill_definitions.rating_avg * skill_definitions.rating_count::float8) / (${RATING_RANK_PRIOR_WEIGHT}::float8 + skill_definitions.rating_count::float8) - ${RATING_RANK_PRIOR_MEAN}::float8))::bigint else 0::bigint end)`;

/**
 * The same formula over a `skill_definitions` row, for the scheduler's update.
 * PostgreSQL's `round` on a double rounds half away from zero; the stars term
 * is never negative, where `Math.round` agrees, and the rating term uses
 * `roundHalfAwayFromZero`. The rating term runs on `float8` throughout, in
 * the order `skillRatingRankTerm` does, so both round the same double.
 */
export const skillRankScoreSql: SQL<number> = sql<number>`greatest(0::bigint, least(${MAX_RANK_SCORE}::bigint, skill_definitions.install_count::bigint * 100 + round(100 * ln(1 + greatest(skill_definitions.repo_stars, 0)))::bigint + ${ratingRankTermSql}))::int`;

/**
 * Lower is more trusted: ours, then what this workspace or its team wrote
 * themselves, then community skills from a featured publisher, then ones a
 * market admin vouched for, then the rest. Featured goes above verified
 * because it is about who stands behind the skill — a major vendor's own
 * repository — which is the stronger word; a skill that is both counts as
 * featured (and leads the featured ones, see `compareRecommendedSkills`).
 */
export function skillTrustTier(
  skill: Pick<SkillRankSignals, "sourceType" | "verified" | "featured">,
): number {
  if (skill.sourceType === "builtin") {
    return 0;
  }
  if (skill.sourceType !== "registry_github") {
    return 1;
  }
  if (skill.featured) {
    return 2;
  }
  return skill.verified ? 3 : 4;
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
    // Only decides anything among featured skills — every other tier is all
    // verified or all not — where an admin's word on top of the publisher's
    // goes first. The SQL order is (featured, verified, …) for the same reason.
    Number(b.verified ?? false) - Number(a.verified ?? false) ||
    skillRankScore(b) - skillRankScore(a) ||
    listedAtMs(b.listedAt) - listedAtMs(a.listedAt) ||
    (a.skillId < b.skillId ? 1 : a.skillId > b.skillId ? -1 : 0)
  );
}

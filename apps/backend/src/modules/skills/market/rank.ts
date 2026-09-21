/**
 * What "recommended" means, in one place: whose word stands behind a skill
 * first, then how many workspaces keep it on, then how recently it was listed.
 *
 * Two readers. The agent's `search_skills` uses the comparator to order
 * entries that fit the query equally well. The catalog's `recommended` sort is
 * the same ordering over community skills alone — where only the
 * verified/community step of the trust ladder is left — written as ORDER BY in
 * `catalog-query.ts` so it can be paged; a database test holds the two
 * together.
 */

export type SkillRankSignals = {
  skillId: string;
  sourceType: string;
  /** A market admin's grant. Never self-asserted, so absent means false. */
  verified?: boolean;
  installCount?: number;
  /** ISO time the skill first went public; null or absent while unlisted. */
  listedAt?: string | null;
};

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
    (b.installCount ?? 0) - (a.installCount ?? 0) ||
    listedAtMs(b.listedAt) - listedAtMs(a.listedAt) ||
    (a.skillId < b.skillId ? 1 : a.skillId > b.skillId ? -1 : 0)
  );
}

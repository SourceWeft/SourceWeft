import "server-only";

import { unstable_cache } from "next/cache";
import {
  skillRunStatsPublicSchema,
  type SkillRunStatsPublic,
} from "@sourceweft/contracts";

import { apiBaseUrl } from "./api-base-url";

/**
 * A public skill's sandbox run stats (§17.5), read anonymously for the public
 * skill page. The API answers `{ available: false }` below its floor of runs
 * and workspaces, and says no more than that.
 */

// Same as the rest of the public skill page (`market-skills.ts`): this cache,
// then the API's own 60-second public cache in front of it.
const RUN_STATS_REVALIDATE_SECONDS = 60;

export type AvailablePublicSkillRunStats = Extract<
  SkillRunStatsPublic,
  { available: true }
>;

// Rethrows on any failure so an outage is never cached as "no stats"; the
// fallback lives in the exported wrapper, outside the cache.
const cachedRunStats = unstable_cache(
  async (slug: string): Promise<SkillRunStatsPublic> => {
    const response = await fetch(
      `${apiBaseUrl}/v1/skills/${encodeURIComponent(slug)}/run-stats`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`Run stats request failed with ${response.status}`);
    }
    return skillRunStatsPublicSchema.parse(await response.json());
  },
  ["public-skill-run-stats"],
  { revalidate: RUN_STATS_REVALIDATE_SECONDS },
);

/**
 * The stats when the public page may show them; null when it may not, when the
 * skill is not public, and on any failure — the stats are an extra, never a
 * reason for the page to fail.
 */
export async function getPublicSkillRunStats(
  slug: string,
): Promise<AvailablePublicSkillRunStats | null> {
  try {
    const stats = await cachedRunStats(slug);
    return stats.available ? stats : null;
  } catch {
    return null;
  }
}

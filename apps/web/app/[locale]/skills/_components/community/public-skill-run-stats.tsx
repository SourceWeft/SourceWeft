import { getPublicSkillRunStats } from "../../../../../lib/public-skill-run-stats";
import { PublicSkillRunStatsPanel } from "./public-skill-run-stats-view";
import type { PublicSkillSlotProps } from "./slot-props";

/**
 * Sandbox run stats in the side column (§17.5): read anonymously, shown only
 * once the skill clears the API's floor of runs and workspaces. Nothing below
 * it, for a skill that is not public, or when the request fails.
 */
export async function PublicSkillRunStats({
  slug,
  locale,
}: PublicSkillSlotProps) {
  const stats = await getPublicSkillRunStats(slug);
  return stats ? (
    <PublicSkillRunStatsPanel locale={locale} stats={stats} />
  ) : null;
}

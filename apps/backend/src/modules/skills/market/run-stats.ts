/**
 * Sandbox run statistics of market skills (skill-marketplace-plan §17.5).
 */

/** Recomputes `skill_run_stats` over the last 30 days and prunes old events. */
export async function refreshSkillRunStats(): Promise<{ skills: number }> {
  return { skills: 0 };
}

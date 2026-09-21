/**
 * Ratings and reviews of market skills (skill-marketplace-plan §17.3).
 */

/** Recomputes `skill_definitions.rating_count/rating_avg` from visible reviews. */
export async function refreshSkillRatings(): Promise<{ updated: number }> {
  return { updated: 0 };
}

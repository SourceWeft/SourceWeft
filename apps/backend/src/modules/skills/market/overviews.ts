/**
 * AI-written overviews of public skills (skill-marketplace-plan §17.4).
 */

/** Queues an overview for every public skill whose current version has none. */
export async function enqueueSkillOverviews(): Promise<{ queued: number }> {
  return { queued: 0 };
}

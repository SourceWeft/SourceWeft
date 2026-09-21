import "server-only";

import { unstable_cache } from "next/cache";
import {
  listSkillReviewsResponseSchema,
  type ListSkillReviewsResponse,
} from "@sourceweft/contracts";

import { apiBaseUrl } from "./api-base-url";

/**
 * A public skill's first page of reviews, read anonymously for the server
 * render so the reviews are in the page's HTML. Anonymous on purpose: the
 * cached answer is the same for every visitor, so no session goes with it and
 * the `viewer` part it carries is always "signed out".
 */

// As the skill itself (`market-skills.ts`): a new review shows within about a
// minute of this cache expiring.
const REVIEWS_REVALIDATE_SECONDS = 60;

export const PUBLIC_SKILL_REVIEWS_PAGE_SIZE = 10;

async function fetchPublicSkillReviews(
  slug: string,
): Promise<ListSkillReviewsResponse | null> {
  const response = await fetch(
    `${apiBaseUrl}/v1/skills/${encodeURIComponent(slug)}/reviews?sort=newest&limit=${PUBLIC_SKILL_REVIEWS_PAGE_SIZE}`,
    { credentials: "omit", headers: { accept: "application/json" } },
  );
  // Not public (or not there): no reviews to show, and nothing to retry.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Skill reviews request failed with ${response.status}`);
  }
  const parsed = listSkillReviewsResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("Skill reviews response does not match the contract");
  }
  return parsed.data;
}

// Rethrows on failure, so an outage is never cached as "no reviews"; the
// fallback lives in the exported wrapper, outside the cache.
const cachedPublicSkillReviews = unstable_cache(
  fetchPublicSkillReviews,
  ["public-skill-reviews"],
  { revalidate: REVIEWS_REVALIDATE_SECONDS },
);

/**
 * The first page of reviews, or null when there is none to show: the skill is
 * not public, or the API could not answer. Reviews are secondary on the page,
 * so a failure here never breaks it.
 */
export async function getPublicSkillReviews(
  slug: string,
): Promise<ListSkillReviewsResponse | null> {
  try {
    return await cachedPublicSkillReviews(slug);
  } catch {
    return null;
  }
}

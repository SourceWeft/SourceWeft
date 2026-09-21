import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import {
  MarketClient,
  MarketClientError,
  type GetMarketSkillResponse,
  type ListMarketSkillCategoriesResponse,
  type ListMarketSkillsRequest,
  type ListMarketSkillsResponse,
} from "@sourceweft/market-sdk";

import { apiBaseUrl } from "./api-base-url";

function marketClient() {
  // The public skill market is served by the backend at {backend}/v1/skills —
  // anonymous, so no service token.
  return new MarketClient({ baseUrl: apiBaseUrl });
}

export function isMarketNotFound(error: unknown) {
  return error instanceof MarketClientError && error.status === 404;
}

const SKILL_REVALIDATE_SECONDS = 300;

// The catalog is identical for every visitor, so it is cached across requests
// rather than re-fetched per crawl. Each cached callback rethrows on failure so
// that an outage is never stored as an empty catalog; the fallback lives in the
// exported wrapper, outside the cache.
const cachedListSkills = unstable_cache(
  async (input: ListMarketSkillsRequest) => marketClient().listSkills(input),
  ["public-skills-list"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

export async function listPublicSkills(
  input: ListMarketSkillsRequest = {},
): Promise<ListMarketSkillsResponse> {
  try {
    return await cachedListSkills(input);
  } catch {
    return { items: [], nextCursor: null };
  }
}

const cachedListSkillCategories = unstable_cache(
  async () => marketClient().listSkillCategories(),
  ["public-skills-categories"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

export async function listPublicSkillCategories(): Promise<ListMarketSkillCategoriesResponse> {
  try {
    return await cachedListSkillCategories();
  } catch {
    return { items: [], total: 0 };
  }
}

/**
 * Propagates market failures instead of returning an empty list. Category pages
 * must use this: with the swallowing variant an outage is indistinguishable
 * from "no such category" and would 404 every category page at once.
 */
export function requirePublicSkillCategories(): Promise<ListMarketSkillCategoriesResponse> {
  return cachedListSkillCategories();
}

const cachedSkill = unstable_cache(
  async (slug: string) => marketClient().getSkill(slug),
  ["public-skill"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

// Never swallowed: the detail page must tell a 404 (not public, withdrawn) from
// an outage, and an outage must not deindex the page. `cache` dedupes the
// generateMetadata + page render pair within one request.
export const getPublicSkill = cache(
  (slug: string): Promise<GetMarketSkillResponse> => cachedSkill(slug),
);

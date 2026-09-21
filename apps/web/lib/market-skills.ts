import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import {
  MarketClient,
  MarketClientError,
  type GetMarketSkillCollectionResponse,
  type GetMarketSkillResponse,
  type ListMarketSkillCategoriesResponse,
  type ListMarketSkillCollectionsResponse,
  type ListMarketSkillsRequest,
  type ListMarketSkillsResponse,
  type MarketSkillLocale,
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

// A new version or a withdrawal shows within about two minutes: this cache,
// then the API's own 60-second public cache in front of it.
const SKILL_REVALIDATE_SECONDS = 60;

// The catalog is identical for every visitor, so it is cached across requests
// rather than re-fetched per crawl. Each cached callback rethrows on failure so
// that an outage is never stored as an empty catalog; the fallback lives in the
// exported wrapper, outside the cache.
const cachedListSkills = unstable_cache(
  async (input: ListMarketSkillsRequest) => marketClient().listSkills(input),
  ["public-skills-list"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

const MARKET_SKILL_LOCALES: readonly string[] = ["en", "zh-CN", "zh-TW"];

/**
 * A route's locale as one the market writes AI summaries in; English for
 * anything else.
 */
export function marketSkillLocale(
  locale: string | null | undefined,
): MarketSkillLocale {
  return MARKET_SKILL_LOCALES.includes(locale ?? "")
    ? (locale as MarketSkillLocale)
    : "en";
}

/**
 * One page of the market. `input.locale` picks the language of each item's
 * `aiSummary`, and is part of the cache key with the rest of the request.
 */
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

// The locale is an argument, so it is part of each read's cache key: the AI
// summaries and overview in the answer are in that language. Omitted, the
// market answers in English.
const cachedSkill = unstable_cache(
  async (slug: string, locale?: MarketSkillLocale) =>
    locale
      ? marketClient().getSkill(slug, { locale })
      : marketClient().getSkill(slug),
  ["public-skill"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

// Never swallowed: the detail page must tell a 404 (not public, withdrawn) from
// an outage, and an outage must not deindex the page. `cache` dedupes the
// generateMetadata + page render pair within one request.
export const getPublicSkill = cache(
  (slug: string, locale?: MarketSkillLocale): Promise<GetMarketSkillResponse> =>
    cachedSkill(slug, locale),
);

const cachedListSkillCollections = unstable_cache(
  async () => marketClient().listSkillCollections(),
  ["public-skills-collections"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

/** Published collections; none on an outage, so the directory still renders. */
export async function listPublicSkillCollections(): Promise<ListMarketSkillCollectionsResponse> {
  try {
    return await cachedListSkillCollections();
  } catch {
    return { items: [] };
  }
}

const cachedSkillCollection = unstable_cache(
  async (slug: string, locale?: MarketSkillLocale) =>
    locale
      ? marketClient().getSkillCollection(slug, { locale })
      : marketClient().getSkillCollection(slug),
  ["public-skill-collection"],
  { revalidate: SKILL_REVALIDATE_SECONDS },
);

// Never swallowed, like a skill's page: a 404 and an outage must stay apart.
export const getPublicSkillCollection = cache(
  (
    slug: string,
    locale?: MarketSkillLocale,
  ): Promise<GetMarketSkillCollectionResponse> =>
    cachedSkillCollection(slug, locale),
);

import type { RateLimitRule } from "../../../shared/rate-limit";

/**
 * What one discovery request can cost the platform: up to five searches at the
 * search provider, which are not metered to the user's credits. These bound
 * that cost; a human researching does not come near them, a script does.
 * Code constants, not settings; they are meant to be tightened from the logs.
 *
 * Worst case sustained: a user about 0.56 USD an hour (150 requests x 5
 * searches), a team about 2.25 USD an hour.
 */
export const DISCOVERY_LIMITS = {
  userPerMinute: 10,
  userPerHour: 150,
  userPerDay: 600,
  teamPerHour: 600,
} as const;

/** Planned queries per topic change rarely; search hits go stale in hours. */
export const DISCOVERY_PLAN_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const DISCOVERY_SEARCH_CACHE_TTL_SECONDS = 60 * 60;
/** An empty answer may be a provider hiccup, so it is kept only briefly. */
export const DISCOVERY_EMPTY_SEARCH_CACHE_TTL_SECONDS = 5 * 60;

export function discoveryRateRules(input: {
  userId: string;
  teamId: string;
}): RateLimitRule[] {
  return [
    {
      key: `source-discovery:user:${input.userId}`,
      limit: DISCOVERY_LIMITS.userPerMinute,
      windowSeconds: 60,
      scope: "minute",
    },
    {
      key: `source-discovery:user:${input.userId}`,
      limit: DISCOVERY_LIMITS.userPerHour,
      windowSeconds: 3600,
      scope: "hour",
    },
    {
      key: `source-discovery:user:${input.userId}`,
      limit: DISCOVERY_LIMITS.userPerDay,
      windowSeconds: 86_400,
      scope: "day",
    },
    {
      key: `source-discovery:team:${input.teamId}`,
      limit: DISCOVERY_LIMITS.teamPerHour,
      windowSeconds: 3600,
      scope: "team",
    },
  ];
}

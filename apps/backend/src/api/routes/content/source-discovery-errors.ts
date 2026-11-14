import type { SourceDiscoveryRateLimitDetails } from "@sourceweft/contracts/sources";
import { ApiError } from "../../response/api-response";

const MESSAGES: Record<SourceDiscoveryRateLimitDetails["scope"], string> = {
  minute: "You are searching quickly. Try again in a moment.",
  hour: "You have reached the hourly limit for finding sources. Try again later.",
  day: "You have reached today's limit for finding sources. Try again tomorrow.",
  team: "Your team has reached its hourly limit for finding sources. Try again later.",
};

/**
 * The 429 for a refused discovery request. The details say which limit it was
 * and when it clears, so a client can show a countdown instead of a guess.
 */
export function discoveryRateLimitedError(
  limited: SourceDiscoveryRateLimitDetails,
) {
  return new ApiError(
    429,
    "SOURCE_DISCOVERY_RATE_LIMITED",
    MESSAGES[limited.scope],
    {
      scope: limited.scope,
      retryAfterSeconds: limited.retryAfterSeconds,
      limit: limited.limit,
      windowSeconds: limited.windowSeconds,
    },
  );
}

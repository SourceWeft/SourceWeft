import type {
  SourceDiscoveryCandidate,
  SourceDiscoveryRateLimitDetails,
  SourceDiscoveryResponse,
} from "@sourceweft/contracts/sources";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import { parseYouTubeUrl } from "@sourceweft/builtin-document-parsers/youtube";
import { logger } from "../../../shared/logger";
import { BillingAdmissionError } from "../../../shared/model-gateway/index";
import { rateLimiter, type RateLimiter } from "../../../shared/rate-limit";
import { jsonCache, type JsonCache } from "../../../shared/redis-cache";
import { ContentError } from "../../content/errors";
import type { ContentBillingPort } from "../../content/billing-port";
import { requireContentWorkspace } from "../../workspace/guards";
import { workspaceService } from "../../workspace";
import { findSourceRecordByExternalUri } from "../repository";
import { createDefaultWebProvider } from "../web-provider";
import { discoveryPlanKey, discoverySearchKey } from "./cache-keys";
import {
  buildCandidates,
  DISCOVERY_RESULTS_PER_QUERY,
  interleaveHits,
  type RawSearchHit,
} from "./candidates";
import {
  DISCOVERY_EMPTY_SEARCH_CACHE_TTL_SECONDS,
  DISCOVERY_PLAN_CACHE_TTL_SECONDS,
  DISCOVERY_SEARCH_CACHE_TTL_SECONDS,
  discoveryRateRules,
} from "./limits";
import { planSearchQueries } from "./planner";

export type DiscoveryDeps = {
  billing: ContentBillingPort;
  getProvider?: () => Promise<AgentToolWebProvider | null>;
  planQueries?: typeof planSearchQueries;
  rateLimiter?: RateLimiter;
  cache?: JsonCache;
  findExistingSourceId?: (input: {
    teamId: string;
    workspaceId: string;
    url: string;
  }) => Promise<string | null>;
};

export type DiscoveryResult =
  | ({ kind: "ok" } & SourceDiscoveryResponse)
  | ({ kind: "limited" } & SourceDiscoveryRateLimitDetails);

/** Whether this deployment has a web search provider; discovery is hidden without one. */
export async function isSourceDiscoveryAvailable(
  getProvider: () => Promise<AgentToolWebProvider | null> = () =>
    createDefaultWebProvider(),
) {
  return Boolean(await getProvider());
}

async function defaultFindExistingSourceId(input: {
  teamId: string;
  workspaceId: string;
  url: string;
}) {
  // A candidate's `url` is already the canonical `watch?v=` URL for a
  // YouTube video (see `buildCandidates`), so it is looked up as a `youtube`
  // source, same as every other candidate's page as a `web_url` source.
  const target = parseYouTubeUrl(input.url);
  const sourceType = target?.kind === "video" ? "youtube" : "web_url";
  const existing = await findSourceRecordByExternalUri({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceType,
    externalUri: input.url,
  });
  return existing?.id ?? null;
}

/**
 * Finds candidate web pages for a topic. It plans a few search queries (one
 * model call, charged to the requester), runs them, and returns a
 * de-duplicated list. Nothing is stored and nothing is ingested: importing is
 * the user's separate choice, one URL source per page.
 *
 * Planned queries and search hits are cached (they are public and the same for
 * everyone). Only work that has to reach the model or the search provider uses
 * up the rate limit: an answer served entirely from cache costs nothing and is
 * never refused.
 */
export async function discoverSources(
  input: {
    workspaceId: string;
    userId: string;
    topic: string;
    requestId: string;
  },
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const workspace = await requireContentWorkspace(input);
  const provider = await (
    deps.getProvider ?? (() => createDefaultWebProvider())
  )();
  if (!provider) {
    throw new ContentError(
      503,
      "WEB_PROVIDER_UNAVAILABLE",
      "Web search is not available on this deployment.",
    );
  }

  const billingOrganizationId =
    await workspaceService.resolveBillingOrganizationId({
      workspaceId: workspace.id,
      userId: input.userId,
      workspaceOrganizationId: workspace.organizationId,
    });

  const cache = deps.cache ?? jsonCache;
  const limiter = deps.rateLimiter ?? rateLimiter;
  const searchKey = (query: string) =>
    discoverySearchKey(query, DISCOVERY_RESULTS_PER_QUERY);

  const cachedPlan = await cache.get<string[]>(discoveryPlanKey(input.topic));
  let queries = cachedPlan?.value ?? null;
  const cachedHits = new Map<
    string,
    { hits: RawSearchHit[]; storedAt: number }
  >();
  if (queries) {
    await Promise.all(
      queries.map(async (query) => {
        const entry = await cache.get<RawSearchHit[]>(searchKey(query));
        if (entry)
          cachedHits.set(query, {
            hits: entry.value,
            storedAt: entry.storedAt,
          });
      }),
    );
  }
  const fullyCached =
    queries !== null && queries.every((query) => cachedHits.has(query));

  if (!fullyCached) {
    let verdict;
    try {
      verdict = await limiter.consume(
        discoveryRateRules({
          userId: input.userId,
          teamId: billingOrganizationId,
        }),
      );
    } catch (error) {
      // The limit protects money the platform spends: with no way to count, no
      // work is started.
      logger.error("Source discovery rate limiter unavailable", { err: error });
      throw new ContentError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Source discovery is unavailable for a moment. Try again shortly.",
      );
    }
    if (!verdict.allowed) {
      logger.info("Source discovery rate limited", {
        userId: input.userId,
        scope: verdict.scope,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return {
        kind: "limited",
        scope: verdict.scope as SourceDiscoveryRateLimitDetails["scope"],
        retryAfterSeconds: verdict.retryAfterSeconds,
        limit: verdict.limit,
        windowSeconds: verdict.windowSeconds,
      };
    }
  }

  if (!queries) {
    try {
      queries = await (deps.planQueries ?? planSearchQueries)({
        billing: deps.billing,
        teamId: billingOrganizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        topic: input.topic,
        requestId: input.requestId,
      });
    } catch (error) {
      if (error instanceof BillingAdmissionError) {
        throw new ContentError(
          402,
          "INSUFFICIENT_CREDITS",
          "There are not enough credits to search for sources.",
        );
      }
      throw error;
    }
    await cache.set(
      discoveryPlanKey(input.topic),
      queries,
      DISCOVERY_PLAN_CACHE_TTL_SECONDS,
    );
    // Queries from a new plan may already have hits cached from another topic.
    await Promise.all(
      queries.map(async (query) => {
        const entry = await cache.get<RawSearchHit[]>(searchKey(query));
        if (entry)
          cachedHits.set(query, {
            hits: entry.value,
            storedAt: entry.storedAt,
          });
      }),
    );
  }

  const planned = queries;
  const lists: RawSearchHit[][] = [];
  let failures = 0;
  const outcomes = await Promise.all(
    planned.map(async (query) => {
      const hit = cachedHits.get(query);
      if (hit) return { query, hits: hit.hits, ok: true as const };
      try {
        // Titles, links and snippets are all discovery uses; asking the
        // provider for each page's full text would make every search slower.
        const result = await provider.search({
          query,
          limit: DISCOVERY_RESULTS_PER_QUERY,
          includeContent: false,
        });
        const hits = result.results.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
        }));
        // Kept so a repeat is a cache hit; an empty answer only for a short
        // while, since it may be a provider hiccup. A failure is never kept.
        await cache.set(
          searchKey(query),
          hits,
          hits.length > 0
            ? DISCOVERY_SEARCH_CACHE_TTL_SECONDS
            : DISCOVERY_EMPTY_SEARCH_CACHE_TTL_SECONDS,
        );
        return { query, hits, ok: true as const };
      } catch (error) {
        logger.warn("A source discovery search failed", { err: error });
        return { query, hits: [] as RawSearchHit[], ok: false as const };
      }
    }),
  );
  for (const outcome of outcomes) {
    if (outcome.ok) lists.push(outcome.hits);
    else failures += 1;
  }
  if (failures === planned.length) {
    throw new ContentError(
      502,
      "WEB_SEARCH_FAILED",
      "Web search failed. Try again in a moment.",
    );
  }

  const found = buildCandidates({ hits: interleaveHits(lists) });
  const findExisting = deps.findExistingSourceId ?? defaultFindExistingSourceId;
  const candidates: SourceDiscoveryCandidate[] = await Promise.all(
    found.map(async (candidate) => ({
      ...candidate,
      existingSourceId: await findExisting({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        url: candidate.url,
      }),
    })),
  );

  const storedTimes = [
    cachedPlan?.storedAt,
    ...planned.map((query) => cachedHits.get(query)?.storedAt),
  ];
  const answeredFromCache =
    fullyCached && storedTimes.every((time) => typeof time === "number");
  return {
    kind: "ok",
    queries: planned,
    candidates,
    cached: answeredFromCache,
    cachedAt: answeredFromCache
      ? new Date(Math.min(...(storedTimes as number[]))).toISOString()
      : null,
  };
}

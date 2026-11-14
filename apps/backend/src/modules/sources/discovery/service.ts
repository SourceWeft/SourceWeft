import type {
  SourceDiscoveryCandidate,
  SourceDiscoveryResponse,
} from "@sourceweft/contracts/sources";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import { logger } from "../../../shared/logger";
import { BillingAdmissionError } from "../../../shared/model-gateway/index";
import { ContentError } from "../../content/errors";
import type { ContentBillingPort } from "../../content/billing-port";
import { requireContentWorkspace } from "../../workspace/guards";
import { workspaceService } from "../../workspace";
import { findSourceRecordByExternalUri } from "../repository";
import { createDefaultWebProvider } from "../web-provider";
import {
  buildCandidates,
  DISCOVERY_RESULTS_PER_QUERY,
  interleaveHits,
  type RawSearchHit,
} from "./candidates";
import { planSearchQueries } from "./planner";

export type DiscoveryDeps = {
  billing: ContentBillingPort;
  getProvider?: () => Promise<AgentToolWebProvider | null>;
  planQueries?: typeof planSearchQueries;
  findExistingSourceId?: (input: {
    teamId: string;
    workspaceId: string;
    url: string;
  }) => Promise<string | null>;
};

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
  const existing = await findSourceRecordByExternalUri({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceType: "web_url",
    externalUri: input.url,
  });
  return existing?.id ?? null;
}

/**
 * Finds candidate web pages for a topic. It plans a few search queries (one
 * model call, charged to the requester), runs them, and returns a
 * de-duplicated list. Nothing is stored and nothing is ingested: importing is
 * the user's separate choice, one URL source per page.
 */
export async function discoverSources(
  input: {
    workspaceId: string;
    userId: string;
    topic: string;
    requestId: string;
  },
  deps: DiscoveryDeps,
): Promise<SourceDiscoveryResponse> {
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

  let queries: string[];
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

  const settled = await Promise.allSettled(
    queries.map((query) =>
      provider.search({ query, limit: DISCOVERY_RESULTS_PER_QUERY }),
    ),
  );
  const lists: RawSearchHit[][] = [];
  let failures = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      lists.push(
        result.value.results.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
        })),
      );
    } else {
      failures += 1;
      logger.warn("A source discovery search failed", { err: result.reason });
    }
  }
  if (failures === queries.length) {
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
  return { queries, candidates };
}

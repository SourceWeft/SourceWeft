import { ParserContentError } from "@sourceweft/builtin-document-parsers";
import {
  parseYouTubeUrl,
  type YouTubeCatalogProvider,
} from "@sourceweft/builtin-document-parsers/youtube";
import type { YouTubeListingResponse } from "@sourceweft/contracts/sources";
import { logger } from "../../../shared/logger";
import { rateLimiter, type RateLimiter } from "../../../shared/rate-limit";
import { ContentError } from "../../content/errors";
import { discoveryRateRules } from "../discovery/limits";
import { findSourceRecordByExternalUri } from "../repository";
import { getYouTubeCatalogProvider } from "./providers";

export type ListYouTubeCollectionDeps = {
  catalog?: YouTubeCatalogProvider;
  rateLimiter?: RateLimiter;
  findExistingSourceId?: (input: {
    teamId: string;
    workspaceId: string;
    url: string;
  }) => Promise<string | null>;
};

async function defaultFindExistingSourceId(input: {
  teamId: string;
  workspaceId: string;
  url: string;
}) {
  const existing = await findSourceRecordByExternalUri({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    sourceType: "youtube",
    externalUri: input.url,
  });
  return existing?.id ?? null;
}

function youTubeUrlUnsupportedError(url: string) {
  return new ContentError(
    422,
    "YOUTUBE_URL_UNSUPPORTED",
    `This YouTube link is not a playlist or channel link: ${url}`,
  );
}

/**
 * Lists the (up to 15) videos of a YouTube playlist or channel, each marked
 * with the workspace's existing `youtube` source for it, if any — so the
 * caller can offer to import the videos that are not already sources.
 *
 * A link to a single video is refused with `YOUTUBE_URL_UNSUPPORTED`: that
 * link is added directly (`createUrlSource`), it is never listed.
 *
 * Shares the source-discovery per-user/per-team rate limiter buckets (same
 * limits, same keys) rather than its own: both features spend the same kind
 * of budget (unmetered calls this deployment makes to the open web on the
 * requester's behalf).
 */
export async function listYouTubeCollection(
  input: { teamId: string; workspaceId: string; userId: string; url: string },
  deps: ListYouTubeCollectionDeps = {},
): Promise<YouTubeListingResponse> {
  const target = parseYouTubeUrl(input.url.trim());
  if (!target || target.kind === "video") {
    throw youTubeUrlUnsupportedError(input.url);
  }

  const limiter = deps.rateLimiter ?? rateLimiter;
  let verdict;
  try {
    verdict = await limiter.consume(
      discoveryRateRules({ userId: input.userId, teamId: input.teamId }),
    );
  } catch (error) {
    logger.error("YouTube listing rate limiter unavailable", { err: error });
    throw new ContentError(
      503,
      "RATE_LIMIT_UNAVAILABLE",
      "YouTube listing is unavailable for a moment. Try again shortly.",
    );
  }
  if (!verdict.allowed) {
    throw new ContentError(
      429,
      "SOURCE_DISCOVERY_RATE_LIMITED",
      "You have reached the limit for listing YouTube videos. Try again later.",
      {
        details: {
          scope: verdict.scope,
          retryAfterSeconds: verdict.retryAfterSeconds,
          limit: verdict.limit,
          windowSeconds: verdict.windowSeconds,
        },
        exposeDetails: true,
      },
    );
  }

  const catalog = deps.catalog ?? getYouTubeCatalogProvider();
  let collection;
  try {
    collection = await catalog.listCollection(target);
  } catch (error) {
    if (error instanceof ParserContentError) {
      throw new ContentError(error.statusCode, error.code, error.message);
    }
    throw error;
  }

  const findExisting = deps.findExistingSourceId ?? defaultFindExistingSourceId;
  const videos = await Promise.all(
    collection.videos.map(async (video) => ({
      ...video,
      existingSourceId: await findExisting({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        url: video.url,
      }),
    })),
  );

  return {
    kind: collection.kind,
    title: collection.title,
    channelTitle: collection.channelTitle,
    videos,
  };
}

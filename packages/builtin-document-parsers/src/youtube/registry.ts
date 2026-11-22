/**
 * Catalog/transcript provider registries, keyed by provider id, plus the
 * default ids. There is one implementation of each today
 * (`public-feeds`/`gemini`); a second provider (Supadata, FetchTranscript,
 * on-device captions, …) adds its id here without touching callers.
 */
import {
  createPublicFeedsCatalogProvider,
  type PublicFeedsCatalogProviderDeps,
} from "./catalog/public-feeds";
import type { YouTubeCatalogProvider } from "./catalog/types";
import { YouTubeSourceError } from "./errors";
import { createGeminiTranscriptProvider } from "./transcript/gemini";
import type { VideoModelPort, YouTubeTranscriptProvider } from "./transcript/types";

export const YOUTUBE_CATALOG_PROVIDER_IDS = ["public-feeds"] as const;
export const YOUTUBE_TRANSCRIPT_PROVIDER_IDS = ["gemini"] as const;

export const DEFAULT_YOUTUBE_CATALOG_PROVIDER_ID = "public-feeds";
export const DEFAULT_YOUTUBE_TRANSCRIPT_PROVIDER_ID = "gemini";

export function createYouTubeCatalogProvider(
  id: string,
  deps: PublicFeedsCatalogProviderDeps,
): YouTubeCatalogProvider {
  switch (id) {
    case "public-feeds":
      return createPublicFeedsCatalogProvider(deps);
    default:
      throw new YouTubeSourceError(
        500,
        "YOUTUBE_CATALOG_PROVIDER_UNKNOWN",
        `Unknown YouTube catalog provider: ${id}`,
      );
  }
}

export function createYouTubeTranscriptProvider(
  id: string,
  deps: { model: VideoModelPort },
): YouTubeTranscriptProvider {
  switch (id) {
    case "gemini":
      return createGeminiTranscriptProvider(deps);
    default:
      throw new YouTubeSourceError(
        500,
        "YOUTUBE_TRANSCRIPT_PROVIDER_UNKNOWN",
        `Unknown YouTube transcript provider: ${id}`,
      );
  }
}

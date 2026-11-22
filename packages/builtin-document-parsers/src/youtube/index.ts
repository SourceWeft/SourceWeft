/**
 * Public surface of the YouTube source support: URL parsing, catalog
 * lookup/listing, transcript providers, source markdown formatting, the
 * `youtube` `SourceParser`, and the provider registries/defaults.
 */
export type { YouTubeChannelRef, YouTubeUrlTarget } from "./url";
export {
  canonicalVideoUrl,
  isUnrecognisedYouTubeUrl,
  isYouTubeHost,
  parseYouTubeUrl,
  timestampUrl,
} from "./url";

export { YouTubeSourceError } from "./errors";

export type {
  YouTubeCatalogProvider,
  YouTubeCollection,
  YouTubeCollectionVideo,
  YouTubeVideoInfo,
} from "./catalog/types";
export {
  createPublicFeedsCatalogProvider,
  type PublicFeedsCatalogProviderDeps,
} from "./catalog/public-feeds";

export {
  YOUTUBE_TRANSCRIPT_MAX_OUTPUT_TOKENS,
  type VideoModelPort,
  type YouTubeTranscript,
  type YouTubeTranscriptProvider,
  type YouTubeTranscriptSegment,
} from "./transcript/types";
export { parseTranscriptOutput } from "./transcript/parse";
export { createGeminiTranscriptProvider } from "./transcript/gemini";

export { formatYouTubeSourceMarkdown, YOUTUBE_SOURCE_MIME_TYPE } from "./format";

export { YouTubeSourceParser } from "./parser";

export {
  createYouTubeCatalogProvider,
  createYouTubeTranscriptProvider,
  DEFAULT_YOUTUBE_CATALOG_PROVIDER_ID,
  DEFAULT_YOUTUBE_TRANSCRIPT_PROVIDER_ID,
  YOUTUBE_CATALOG_PROVIDER_IDS,
  YOUTUBE_TRANSCRIPT_PROVIDER_IDS,
} from "./registry";

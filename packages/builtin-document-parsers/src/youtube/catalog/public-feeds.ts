/**
 * `public-feeds` YouTube catalog provider.
 *
 * Fetches video metadata from YouTube's public oEmbed endpoint and playlist/
 * channel listings from YouTube's public Atom feeds
 * (`/feeds/videos.xml`), with no API key. A handle or custom-URL channel
 * reference is resolved to a channel id first by scraping the channel's
 * public page, since the feeds endpoint only accepts `channel_id`/`user`.
 */
import { XMLParser } from "fast-xml-parser";
import { YouTubeSourceError } from "../errors";
import { canonicalVideoUrl, type YouTubeChannelRef, type YouTubeUrlTarget } from "../url";
import type {
  YouTubeCatalogProvider,
  YouTubeCollection,
  YouTubeCollectionVideo,
  YouTubeVideoInfo,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_COLLECTION_ENTRIES = 15;
const FEEDS_BASE_URL = "https://www.youtube.com/feeds/videos.xml";

/** Hosts a channel page may finish on; anything else (a consent wall) is not the page. */
const CHANNEL_PAGE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

const CHANNEL_ID_JSON_RE = /"channelId":"(UC[A-Za-z0-9_-]{22})"/;
const CHANNEL_ID_CANONICAL_LINK_RE =
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/;

export type PublicFeedsCatalogProviderDeps = {
  fetch: typeof fetch;
  timeoutMs?: number;
};

function fallbackVideoInfo(videoId: string): YouTubeVideoInfo {
  return { videoId, title: `YouTube video ${videoId}`, titleSource: "fallback" };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The host the request finished on after redirects; `null` when unknown. */
function finalResponseHost(response: Response): string | null {
  if (!response.url) return null;
  try {
    return new URL(response.url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPublicFeedsCatalogProvider(
  deps: PublicFeedsCatalogProviderDeps,
): YouTubeCatalogProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Feed text stays text (a title "2024" or an all-digit video id must not
  // become a number), and HTML entities such as `&#39;` are decoded.
  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    htmlEntities: true,
  });

  function fetchWithTimeout(url: string): Promise<Response> {
    return deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  }

  async function getVideo(videoId: string): Promise<YouTubeVideoInfo> {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      canonicalVideoUrl(videoId),
    )}&format=json`;

    let response: Response;
    try {
      response = await fetchWithTimeout(oembedUrl);
    } catch {
      // Network error or timeout: metadata must never block transcription.
      return fallbackVideoInfo(videoId);
    }

    if (response.status === 400 || response.status === 404) {
      throw new YouTubeSourceError(
        422,
        "YOUTUBE_VIDEO_UNAVAILABLE",
        `YouTube video ${videoId} is unavailable`,
      );
    }

    if (!response.ok) {
      // 401, 403, 5xx or any other non-2xx: fall back rather than block.
      return fallbackVideoInfo(videoId);
    }

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return fallbackVideoInfo(videoId);
    }

    const title = asOptionalString(body.title);
    if (!title) {
      return fallbackVideoInfo(videoId);
    }

    return {
      videoId,
      title,
      titleSource: "oembed",
      channelTitle: asOptionalString(body.author_name),
      channelUrl: asOptionalString(body.author_url),
      thumbnailUrl: asOptionalString(body.thumbnail_url),
    };
  }

  async function resolveChannelIdFromPage(pageUrl: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchWithTimeout(pageUrl);
    } catch (error) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Failed to resolve channel from ${pageUrl}: ${errorMessage(error)}`,
      );
    }

    // A redirect off YouTube (consent.youtube.com, a sign-in wall) says
    // nothing about whether the channel exists: the listing failed.
    const finalHost = finalResponseHost(response);
    if (finalHost !== null && !CHANNEL_PAGE_HOSTS.has(finalHost)) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Channel page ${pageUrl} redirected to ${finalHost}`,
      );
    }

    if (response.status === 404) {
      throw new YouTubeSourceError(
        404,
        "YOUTUBE_CHANNEL_NOT_FOUND",
        `Channel page not found: ${pageUrl}`,
      );
    }

    if (!response.ok) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Failed to resolve channel from ${pageUrl}: HTTP ${response.status}`,
      );
    }

    const html = await response.text();
    const channelId =
      html.match(CHANNEL_ID_JSON_RE)?.[1] ?? html.match(CHANNEL_ID_CANONICAL_LINK_RE)?.[1];

    if (!channelId) {
      throw new YouTubeSourceError(
        404,
        "YOUTUBE_CHANNEL_NOT_FOUND",
        `Could not resolve a channel id from ${pageUrl}`,
      );
    }

    return channelId;
  }

  async function resolveFeedUrl(
    target: Extract<YouTubeUrlTarget, { kind: "playlist" | "channel" }>,
  ): Promise<string> {
    if (target.kind === "playlist") {
      return `${FEEDS_BASE_URL}?playlist_id=${encodeURIComponent(target.playlistId)}`;
    }

    const channel: YouTubeChannelRef = target.channel;
    switch (channel.type) {
      case "id":
        return `${FEEDS_BASE_URL}?channel_id=${encodeURIComponent(channel.value)}`;
      case "user":
        return `${FEEDS_BASE_URL}?user=${encodeURIComponent(channel.value)}`;
      case "handle": {
        const channelId = await resolveChannelIdFromPage(
          `https://www.youtube.com/@${encodeURIComponent(channel.value)}`,
        );
        return `${FEEDS_BASE_URL}?channel_id=${encodeURIComponent(channelId)}`;
      }
      case "custom": {
        const channelId = await resolveChannelIdFromPage(
          `https://www.youtube.com/c/${encodeURIComponent(channel.value)}`,
        );
        return `${FEEDS_BASE_URL}?channel_id=${encodeURIComponent(channelId)}`;
      }
      default:
        throw new YouTubeSourceError(
          502,
          "YOUTUBE_LISTING_FAILED",
          `Unsupported channel reference type: ${(channel as YouTubeChannelRef).type}`,
        );
    }
  }

  function parseEntries(feed: Record<string, unknown>): YouTubeCollectionVideo[] {
    const rawEntries = feed.entry;
    const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];

    return entries.slice(0, MAX_COLLECTION_ENTRIES).map((entry): YouTubeCollectionVideo => {
      const e = entry as Record<string, unknown>;
      const videoId = asOptionalString(e["yt:videoId"]) ?? "";
      const title = asOptionalString(e.title) ?? `YouTube video ${videoId}`;
      const mediaGroup = e["media:group"] as Record<string, unknown> | undefined;
      const thumbnail = mediaGroup?.["media:thumbnail"] as Record<string, unknown> | undefined;
      const thumbnailUrl = asOptionalString(thumbnail?.["@_url"]);
      const publishedAt = asOptionalString(e.published);

      return {
        videoId,
        title,
        url: canonicalVideoUrl(videoId),
        ...(publishedAt ? { publishedAt } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    });
  }

  async function listCollection(
    target: Extract<YouTubeUrlTarget, { kind: "playlist" | "channel" }>,
  ): Promise<YouTubeCollection> {
    const feedUrl = await resolveFeedUrl(target);

    let response: Response;
    try {
      response = await fetchWithTimeout(feedUrl);
    } catch (error) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Failed to fetch feed ${feedUrl}: ${errorMessage(error)}`,
      );
    }

    if (response.status === 404) {
      throw new YouTubeSourceError(
        404,
        "YOUTUBE_CHANNEL_NOT_FOUND",
        `Feed not found: ${feedUrl}`,
      );
    }

    if (!response.ok) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Failed to fetch feed ${feedUrl}: HTTP ${response.status}`,
      );
    }

    const xml = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = xmlParser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Failed to parse feed ${feedUrl}: ${errorMessage(error)}`,
      );
    }

    if (!("feed" in parsed)) {
      throw new YouTubeSourceError(
        502,
        "YOUTUBE_LISTING_FAILED",
        `Feed ${feedUrl} did not contain an Atom <feed> element`,
      );
    }
    // An empty `<feed></feed>` parses to an empty string: a collection with
    // no videos, not a broken feed.
    const feed =
      parsed.feed && typeof parsed.feed === "object"
        ? (parsed.feed as Record<string, unknown>)
        : {};

    const title = asOptionalString(feed.title) ?? "";
    const author = feed.author as Record<string, unknown> | undefined;
    const channelTitle = asOptionalString(author?.name);

    return {
      kind: target.kind,
      title,
      ...(channelTitle ? { channelTitle } : {}),
      videos: parseEntries(feed),
    };
  }

  return {
    id: "public-feeds",
    getVideo,
    listCollection,
  };
}

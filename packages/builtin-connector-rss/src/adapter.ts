import {
  ConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
  type ConnectorItem,
  type ConnectorSyncReadinessResult,
} from "@sourceweft/contracts";
import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { toBackendRssManifest } from "./backend-manifest";
import { RssAdapterError, type RssReadinessReason } from "./errors";
import { fetchFeed } from "./feed-fetch";
import { canonicalLink, contentHashOf } from "./feed-identity";
import { parseFeed } from "./feed-parse";
import { parseFeedUrl } from "./feed-url";
import { FEED_MAX_ITEMS } from "./limits";

export { RssAdapterError } from "./errors";

/** An item read by the preceding discover stays extractable this long. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** At most this many connectors keep a cached feed; the oldest is evicted. */
const CACHE_MAX_CONNECTORS = 50;

export type RssConnectorAdapterInput = {
  publicFetch: () => ConnectorPublicFetchScope;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
  limits?: { timeoutMs?: number; maxBytes?: number; maxItems?: number };
  /** Clock for the extract cache; tests inject one. */
  now?: () => number;
};

type Validators = { etag: string | null; lastModified: string | null };

type DiscoveredItem = { item: ConnectorItem; text: string };

type LoadedFeed =
  | { kind: "not_modified" }
  | {
      kind: "feed";
      title: string;
      items: DiscoveredItem[];
      validators: Validators;
    };

type CacheEntry = { at: number; items: Map<string, DiscoveredItem> };

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function feedUrlOf(config: Record<string, unknown>): string {
  return typeof config.feedUrl === "string" ? config.feedUrl : "";
}

/** The validators the previous complete run committed, if any. */
function committedValidators(
  cursor: ConnectorDiscoverInput["cursor"],
): Validators {
  const committed = cursor?.committed;
  if (typeof committed !== "object" || committed === null) {
    return { etag: null, lastModified: null };
  }
  const record = committed as Record<string, unknown>;
  return {
    etag: stringOrNull(record.etag),
    lastModified: stringOrNull(record.lastModified),
  };
}

export function createRssConnectorAdapter(
  adapterInput: RssConnectorAdapterInput,
): ConnectorAdapter {
  const { publicFetch, logger, limits } = adapterInput;
  const now = adapterInput.now ?? Date.now;
  const maxItems = limits?.maxItems ?? FEED_MAX_ITEMS;
  const cache = new Map<string, CacheEntry>();

  const remember = (connectorId: string, items: DiscoveredItem[]): void => {
    cache.delete(connectorId);
    cache.set(connectorId, {
      at: now(),
      items: new Map(items.map((entry) => [entry.item.externalId, entry])),
    });
    while (cache.size > CACHE_MAX_CONNECTORS) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  /**
   * Fetches and parses the feed through a fresh public-fetch scope. Nothing
   * here ever puts the feed URL (which may hold a token) in an error, a log
   * line or an item: only the host is used.
   */
  async function load(
    config: Record<string, unknown>,
    validators: Validators | undefined,
  ): Promise<LoadedFeed> {
    const feedUrl = feedUrlOf(config);
    const fetched = await fetchFeed({
      publicFetch,
      feedUrl,
      validators,
      timeoutMs: limits?.timeoutMs,
      maxBytes: limits?.maxBytes,
    });
    if (fetched.kind === "not_modified") return { kind: "not_modified" };

    let parsed: ReturnType<typeof parseFeed>;
    try {
      parsed = parseFeed(fetched.body, { maxItems });
    } catch {
      // Parser errors can quote the document; only the fixed reason survives.
      throw new RssAdapterError("feed_not_a_feed");
    }
    const urlParse = parseFeedUrl(feedUrl);
    const feedHost = urlParse.ok ? urlParse.url.hostname : "";
    if (parsed.truncated) {
      logger?.warn?.("rss_feed_truncated", { feedHost, kept: maxItems });
    }
    const items = parsed.items.map((entry): DiscoveredItem => {
      const url = entry.link === null ? null : canonicalLink(entry.link);
      const date = entry.updatedAt ?? entry.publishedAt;
      return {
        text: entry.text,
        item: {
          externalId: entry.externalId,
          externalUri: url,
          title: entry.title === "" ? "(untitled)" : entry.title,
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(entry.text, "utf8"),
          externalUpdatedAt: date,
          contentHash: contentHashOf(entry),
          metadata: {
            feedTitle: parsed.title,
            feedHost,
            author: entry.author,
            publishedAt: entry.publishedAt?.toISOString() ?? null,
            url,
            citationKey: `rss:${feedHost}:${entry.externalId}`,
          },
        },
      };
    });
    return {
      kind: "feed",
      title: parsed.title,
      items,
      validators: { etag: fetched.etag, lastModified: fetched.lastModified },
    };
  }

  async function* discoverPages(
    input: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorDiscoveryPage> {
    const validators = committedValidators(input.cursor);
    const loaded = await load(input.config, validators);
    if (loaded.kind === "not_modified") {
      yield {
        items: [],
        complete: true,
        checkpoint: {
          etag: validators.etag,
          lastModified: validators.lastModified,
        },
        reconcileMissing: false,
      };
      return;
    }
    remember(input.connectorId, loaded.items);
    yield {
      items: loaded.items.map((entry) => entry.item),
      complete: true,
      checkpoint: {
        etag: loaded.validators.etag,
        lastModified: loaded.validators.lastModified,
      },
      // A feed window is not the full history: absence proves nothing.
      reconcileMissing: false,
    };
  }

  async function* discover(
    input: ConnectorDiscoverInput,
  ): AsyncGenerator<ConnectorItem> {
    const loaded = await load(input.config, undefined);
    if (loaded.kind !== "feed") return;
    remember(input.connectorId, loaded.items);
    for (const entry of loaded.items) yield entry.item;
  }

  return {
    getManifest: toBackendRssManifest,

    async checkSyncReadiness(
      input: ConnectorDiscoverInput,
    ): Promise<ConnectorSyncReadinessResult> {
      try {
        const loaded = await load(input.config, undefined);
        if (loaded.kind !== "feed") {
          // Unconditional fetch cannot be answered 304; treat as unreadable.
          throw new RssAdapterError("feed_http_error");
        }
        return {
          ready: true,
          metadata: { title: loaded.title, itemCount: loaded.items.length },
        };
      } catch (error) {
        if (
          error instanceof RssAdapterError &&
          error.reason !== "rss_actions_unsupported"
        ) {
          const reason: RssReadinessReason = error.reason;
          return { ready: false, reason, message: error.message };
        }
        throw error;
      }
    },

    discover,
    discoverPages,

    async extract(
      input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      let entry = cache.get(input.connectorId);
      if (entry === undefined || now() - entry.at > CACHE_TTL_MS) {
        const loaded = await load(input.config, undefined);
        if (loaded.kind !== "feed") {
          throw new ConnectorItemSkipError("unreadable");
        }
        remember(input.connectorId, loaded.items);
        entry = cache.get(input.connectorId);
      }
      const found = entry?.items.get(input.item.externalId);
      if (found === undefined) throw new ConnectorItemSkipError("unreadable");
      if (found.text.trim() === "") {
        throw new ConnectorItemSkipError("empty_content");
      }
      return { item: found.item, contentText: found.text };
    },

    async executeAction(
      _input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      throw new RssAdapterError("rss_actions_unsupported");
    },
  };
}

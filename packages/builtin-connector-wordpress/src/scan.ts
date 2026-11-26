import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { WordPressClient } from "./client";
import {
  MAX_ITEMS,
  MAX_REQUESTS,
  MAX_SCAN_RESTARTS,
  MAX_TAG_IDS,
  SCAN_TIMEOUT_MS,
} from "./limits";
import {
  toConnectorItem,
  type WpListItem,
  type WpNames,
  type WpPost,
} from "./model";
import { fetchSingleItem, nameMap } from "./lookup";
import { resolveScope, type SelectionItem } from "./selection-scope";

/** The caps one scan enforces; each defaults to the matching package limit. */
export type ScanLimits = {
  /** Distinct posts and pages one scan may index, across all selections. */
  MAX_ITEMS: number;
  /** HTTP requests (discovery included) the whole scan may make. */
  MAX_REQUESTS: number;
  /** Wall-clock budget of the whole scan. */
  SCAN_TIMEOUT_MS: number;
  /** Distinct tag ids one scan resolves to names. */
  MAX_TAG_IDS: number;
  /** Times a route restarts after its total moves under it. */
  MAX_SCAN_RESTARTS: number;
};

export type ScanSiteInput = {
  client: WordPressClient;
  /** The connector's selection (kind-qualified ids). Empty means everything. */
  items: SelectionItem[];
  /** Login connector only: also index draft, private, pending and future content. */
  includeUnpublished: boolean;
  /** The validated site host; every item's `link` must resolve to it. */
  siteHost: string;
  now?: () => number;
  limits?: Partial<ScanLimits>;
  signal?: AbortSignal;
  /** Receives a fixed event name and a fixed-reason meta only. */
  logger?: {
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

const DEFAULTS: ScanLimits = {
  MAX_ITEMS,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  MAX_TAG_IDS,
  MAX_SCAN_RESTARTS,
};

/** The fixed event an incomplete scan logs; the only variable is its reason. */
export const SCAN_INCOMPLETE_EVENT = "wordpress_scan_incomplete";

/**
 * Why a scan stopped without a reconcilable result. `too_large` is any cap (an
 * item, request or tag-id ceiling), `timeout` is the wall-clock deadline, and
 * `unstable` is a listing that kept changing past the restart budget. These are
 * the whole content of the member-facing notice: no site address, id or
 * response text is ever logged.
 */
export type ScanIncompleteReason = "too_large" | "timeout" | "unstable";

/** Thrown inside a scan when it must give up without raising a platform error:
 * the run then yields an empty, non-reconciling page and logs the reason. */
class ScanIncomplete extends Error {
  constructor(readonly reason: ScanIncompleteReason) {
    super(reason);
    this.name = "ScanIncomplete";
  }
}

/**
 * Scans the selected posts and pages of one WordPress site and returns exactly
 * one discovery page.
 *
 * A scan that reads its whole scope cleanly is authoritative: it reconciles
 * (`reconcileMissing: true`), so a selected category or single that is gone
 * simply lists nothing and its sources are archived. A scan that hits a cap or
 * the deadline, or that could never read a listing consistently, instead
 * returns an empty, non-reconciling page (`reconcileMissing: false`) and logs a
 * fixed-reason warning, so the run succeeds and partial data archives nothing.
 * Every other failure — a login wall, a rate limit, a 5xx, a 404 mid-listing, a
 * malformed body, a `link` under another host — propagates as a
 * {@link WordPressError}; nothing is skipped and half-indexed.
 */
export async function scanSite(
  input: ScanSiteInput,
): Promise<ConnectorDiscoveryPage> {
  const now = input.now ?? Date.now;
  const limits: ScanLimits = { ...DEFAULTS, ...input.limits };
  const { client, includeUnpublished, siteHost, signal } = input;
  const deadline = now() + limits.SCAN_TIMEOUT_MS;

  /** Enforced before every client call so the caps bound the whole scan. */
  function budget(): void {
    signal?.throwIfAborted();
    if (now() >= deadline) throw new ScanIncomplete("timeout");
    if (client.requestCount() >= limits.MAX_REQUESTS) {
      throw new ScanIncomplete("too_large");
    }
  }

  /** Items that will be indexed, de-duplicated by external id across routes. */
  const found = new Map<string, WpListItem>();
  function admit(item: WpListItem): void {
    const key = `wordpress:${item.type}:${item.id}`;
    if (found.has(key)) return;
    found.set(key, item);
    if (found.size > limits.MAX_ITEMS) throw new ScanIncomplete("too_large");
  }

  function fetchSingle(
    route: "posts" | "pages",
    id: number,
  ): Promise<WpPost | null> {
    return fetchSingleItem(client, route, id, includeUnpublished);
  }

  /**
   * Reads a whole route in id order. If `X-WP-Total` differs between the first
   * and the last request of the route, the listing changed under the read, so
   * it restarts (at most {@link ScanLimits.MAX_SCAN_RESTARTS} times); a read
   * that never stabilises is an unstable scan, never a reconcilable one.
   */
  async function listRoute(
    route: "posts" | "pages",
    categories: number[] | undefined,
  ): Promise<WpListItem[]> {
    for (let attempt = 0; attempt <= limits.MAX_SCAN_RESTARTS; attempt += 1) {
      budget();
      const first = await client.listItems(route, {
        page: 1,
        categories,
        includeUnpublished,
      });
      const rows = [...first.items];
      let lastTotal = first.total;
      for (let page = 2; page <= first.totalPages; page += 1) {
        budget();
        const next = await client.listItems(route, {
          page,
          categories,
          includeUnpublished,
        });
        rows.push(...next.items);
        lastTotal = next.total;
      }
      if (lastTotal === first.total) return rows;
    }
    throw new ScanIncomplete("unstable");
  }

  async function run(): Promise<ConnectorDiscoveryPage> {
    budget();
    const categoryList = await client.listCategories();
    const scope = resolveScope(input.items, categoryList);
    const categoryNames = nameMap(categoryList);

    if (scope.posts.all) {
      for (const item of await listRoute("posts", undefined)) admit(item);
    } else if (scope.posts.categoryIds !== null) {
      for (const item of await listRoute("posts", scope.posts.categoryIds)) {
        admit(item);
      }
    }
    if (scope.pages.all) {
      for (const item of await listRoute("pages", undefined)) admit(item);
    }

    for (const id of scope.posts.postIds) {
      if (found.has(`wordpress:post:${id}`)) continue;
      budget();
      const post = await fetchSingle("posts", id);
      if (post !== null) admit(post);
    }
    for (const id of scope.pages.pageIds) {
      if (found.has(`wordpress:page:${id}`)) continue;
      budget();
      const page = await fetchSingle("pages", id);
      if (page !== null) admit(page);
    }

    // Resolve the tag and author names the found items reference, once.
    const tagIds = new Set<number>();
    const authorIds = new Set<number>();
    for (const item of found.values()) {
      for (const tag of item.tagIds) tagIds.add(tag);
      if (item.authorId !== null) authorIds.add(item.authorId);
    }
    if (tagIds.size > limits.MAX_TAG_IDS) throw new ScanIncomplete("too_large");

    budget();
    const tagList = tagIds.size > 0 ? await client.listTags([...tagIds]) : [];
    const tagNames = nameMap(tagList);

    budget();
    const authorNames =
      authorIds.size > 0
        ? await client.listUsers([...authorIds])
        : new Map<number, string>();

    const names: WpNames = { categories: categoryNames, tags: tagNames };
    const items: ConnectorItem[] = [];
    for (const item of found.values()) {
      const authorName =
        item.authorId !== null
          ? (authorNames.get(item.authorId) ?? null)
          : null;
      items.push(toConnectorItem(item, names, authorName, siteHost));
    }
    // A stable order makes an unchanged site produce an identical page.
    items.sort((a, b) =>
      a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
    );

    return {
      items,
      complete: true,
      reconcileMissing: true,
      checkpoint: null,
    };
  }

  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ScanIncomplete)) throw error;
    // A complete, non-reconciling page: the run succeeds and archives nothing.
    input.logger?.warn?.(SCAN_INCOMPLETE_EVENT, { reason: error.reason });
    return {
      items: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    };
  }
}

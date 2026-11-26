import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { WordPressClient } from "./client";
import { WordPressError, type WordPressRestCode } from "./errors";
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
};

const DEFAULTS: ScanLimits = {
  MAX_ITEMS,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  MAX_TAG_IDS,
  MAX_SCAN_RESTARTS,
};

/**
 * Shown to the member when the scan stopped because the selection is larger
 * than one sync can index (an item, request, tag or time cap). It archives
 * nothing and carries no site address, id or response text.
 */
export const NARROW_SELECTION_WARNING =
  "This WordPress selection is too large to index in a single sync. Narrow it to fewer categories, posts or pages.";

/**
 * Shown to the member when the site kept changing while a listing was read, so
 * the scan could not get one consistent view. It archives nothing and will be
 * retried on the next sync.
 */
export const SITE_CHANGED_WARNING =
  "The WordPress site changed while it was being read, so this sync made no changes. It will be retried on the next sync.";

type IncompleteReason = "narrow" | "unstable";

/** Thrown inside a scan when it must give up without raising a platform error:
 * the run then yields an empty, non-reconciling page with a fixed warning. */
class ScanIncomplete extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
    this.name = "ScanIncomplete";
  }
}

/** R8b: a selected single that answers 401/403 with one of these rights codes
 * has become private or unreadable — it is treated as gone (skipped), like a
 * 404. A `LOGIN_REQUIRED` from any other cause means the whole site now needs a
 * login and stays an error. */
const GONE_WHEN_FORBIDDEN: ReadonlySet<WordPressRestCode> = new Set([
  "rest_forbidden",
  "rest_cannot_view",
  "rest_user_cannot_view",
]);

function singleIsGone(error: unknown): boolean {
  return (
    error instanceof WordPressError &&
    error.code === "LOGIN_REQUIRED" &&
    error.restCode !== undefined &&
    GONE_WHEN_FORBIDDEN.has(error.restCode)
  );
}

/**
 * Scans the selected posts and pages of one WordPress site and returns exactly
 * one discovery page.
 *
 * A scan that reads its whole scope cleanly is authoritative: it reconciles
 * (`reconcileMissing: true`), so a selected category or single that is gone
 * simply lists nothing and its sources are archived. A scan that hits a cap or
 * the deadline, or that could never read a listing consistently, instead
 * returns an empty, non-reconciling page (`complete: false`,
 * `reconcileMissing: false`) with a fixed warning, so partial data never
 * archives anything. Every other failure — a login wall, a rate limit, a 5xx,
 * a 404 mid-listing, a malformed body, a `link` under another host — propagates
 * as a {@link WordPressError}; nothing is skipped and half-indexed.
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
    if (now() >= deadline) throw new ScanIncomplete("narrow");
    if (client.requestCount() >= limits.MAX_REQUESTS) {
      throw new ScanIncomplete("narrow");
    }
  }

  /** Items that will be indexed, de-duplicated by external id across routes. */
  const found = new Map<string, WpListItem>();
  function admit(item: WpListItem): void {
    const key = `wordpress:${item.type}:${item.id}`;
    if (found.has(key)) return;
    found.set(key, item);
    if (found.size > limits.MAX_ITEMS) throw new ScanIncomplete("narrow");
  }

  async function fetchSingle(
    route: "posts" | "pages",
    id: number,
  ): Promise<WpPost | null> {
    try {
      return await client.getItem(route, id, includeUnpublished);
    } catch (error) {
      if (singleIsGone(error)) return null;
      throw error;
    }
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
    const categoryNames = new Map<number, string>(
      categoryList.map((category) => [category.id, category.name]),
    );

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
    if (tagIds.size > limits.MAX_TAG_IDS) throw new ScanIncomplete("narrow");

    budget();
    const tagList = tagIds.size > 0 ? await client.listTags([...tagIds]) : [];
    const tagNames = new Map<number, string>(
      tagList.map((tag) => [tag.id, tag.name]),
    );

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
    return {
      items: [],
      complete: false,
      reconcileMissing: false,
      checkpoint: null,
      warnings: [
        error.reason === "unstable"
          ? SITE_CHANGED_WARNING
          : NARROW_SELECTION_WARNING,
      ],
    };
  }
}

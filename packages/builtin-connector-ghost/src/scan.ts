import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { GhostClient, GhostItemRoute } from "./client";
import { GhostError } from "./errors";
import {
  ID_BATCH,
  MAX_ITEMS,
  MAX_REQUESTS,
  MAX_RETRIES,
  MAX_SCAN_RESTARTS,
  SCAN_TIMEOUT_MS,
} from "./limits";
import { toConnectorItem, type GhostListItem } from "./model";
import {
  resolveScope,
  type RouteScope,
  type SelectionItem,
} from "./selection-scope";

/** The caps one scan enforces; each defaults to the matching package limit. */
export type ScanLimits = {
  /** Distinct posts and pages one scan may read, across all selections. */
  MAX_ITEMS: number;
  /** HTTP requests the whole scan may make (the client's counter). */
  MAX_REQUESTS: number;
  /** Wall-clock budget of the whole scan. */
  SCAN_TIMEOUT_MS: number;
  /** Times a list restarts after its total moves under it. */
  MAX_SCAN_RESTARTS: number;
};

const DEFAULTS: ScanLimits = {
  MAX_ITEMS,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  MAX_SCAN_RESTARTS,
};

export type ScanSiteInput = {
  client: GhostClient;
  /** The connector's selection (kind-qualified ids). Empty means everything. */
  items: SelectionItem[];
  /** The validated site host, recorded in every item's metadata. */
  siteHost: string;
  now?: () => number;
  limits?: Partial<ScanLimits>;
  signal?: AbortSignal;
};

/**
 * One discovery page plus the member-facing notices of the scan. The contract
 * has no field for notices, so they travel beside the page; the adapter logs
 * them and yields only the {@link ConnectorDiscoveryPage} part.
 */
export type GhostScanPage = ConnectorDiscoveryPage & {
  items: ConnectorItem[];
  warnings: string[];
};

/** Shown when a cap or the deadline stopped the scan. */
export const SCAN_NARROW_WARNING =
  "The scan stopped before reading everything. Narrow your selection and sync again.";

/** Shown when a list kept changing while it was read. */
export const SCAN_UNSTABLE_WARNING =
  "The site kept changing while it was read. Nothing was removed; it will be read again at the next sync.";

/** The fixed sentence before the number of skipped members-only items. */
export const SCAN_SKIPPED_WARNING =
  "Members-only or paid items skipped because the key cannot read them in full:";

type IncompleteReason = "too_large" | "timeout" | "unstable";

/** Thrown inside a scan when it must give up without raising a platform error:
 * the run then yields an empty, non-reconciling page. */
class ScanIncomplete extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
    this.name = "ScanIncomplete";
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

type ListSelector = { tagIds?: string[]; ids?: string[] };

/**
 * Scans the selected posts and pages of one Ghost site and returns exactly one
 * discovery page.
 *
 * A scan that reads its whole scope cleanly is authoritative
 * (`reconcileMissing: true`): a selected tag or single that is gone lists
 * nothing and its sources are archived. A scan that hits a cap or the
 * deadline, or whose lists keep changing, returns an empty, non-reconciling
 * page with a fixed warning, so the run succeeds and partial data archives
 * nothing. It is `complete: true` like the other connectors' incomplete scans:
 * the orchestrator fails a run whose last page is not complete. Every other
 * failure (a 404 or 5xx mid-list, a malformed body, a hostile `url`, a bad key)
 * propagates as a {@link GhostError}; nothing is skipped and half-indexed.
 */
export async function scanSite(input: ScanSiteInput): Promise<GhostScanPage> {
  const now = input.now ?? Date.now;
  const limits: ScanLimits = { ...DEFAULTS, ...input.limits };
  const { client, siteHost, signal } = input;
  const scope = resolveScope(input.items);
  const deadline = now() + limits.SCAN_TIMEOUT_MS;

  /** Checked before every client call so the caps bound the whole scan. One
   * call may send its request plus {@link MAX_RETRIES} retries, so that much
   * headroom is kept: the client's own hard ceiling is never reached mid-call. */
  function budget(): void {
    signal?.throwIfAborted();
    if (now() >= deadline) throw new ScanIncomplete("timeout");
    if (client.requestCount() + MAX_RETRIES + 1 > limits.MAX_REQUESTS) {
      throw new ScanIncomplete("too_large");
    }
  }

  /** A client call under the budget. The client has its own hard ceiling on
   * requests, checked before it sends anything: a TOO_LARGE that arrives
   * without the request counter having moved is that ceiling (an oversized
   * response moves the counter first), and ends the scan incomplete instead of
   * failing it. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    budget();
    const before = client.requestCount();
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof GhostError &&
        error.code === "TOO_LARGE" &&
        client.requestCount() === before
      ) {
        throw new ScanIncomplete("too_large");
      }
      throw error;
    }
  }

  /** Every item seen, de-duplicated by external id across lists and routes. */
  const found = new Map<string, GhostListItem>();
  function admit(item: GhostListItem): void {
    const key = `ghost:${item.type}:${item.id}`;
    const existing = found.get(key);
    // Seen twice: keep the accessible copy, so an item that changed visibility
    // between two lists is never dropped on a stale members-only reading.
    if (existing && (existing.access || !item.access)) return;
    found.set(key, item);
    if (found.size > limits.MAX_ITEMS) throw new ScanIncomplete("too_large");
  }

  /**
   * Reads one list in id order. A read is authoritative only when `total` is
   * unchanged between its first and last request and at least that many rows
   * arrived (a site that reports a total it never delivers must not reconcile).
   * Either inconsistency restarts the list, at most
   * {@link ScanLimits.MAX_SCAN_RESTARTS} times; a list that never settles is an
   * unstable scan.
   */
  async function readList(
    route: GhostItemRoute,
    selector: ListSelector,
  ): Promise<GhostListItem[]> {
    for (let attempt = 0; attempt <= limits.MAX_SCAN_RESTARTS; attempt += 1) {
      const first = await call(() =>
        client.listItems(route, { page: 1, ...selector }),
      );
      // One list alone already holds more distinct items than the cap allows.
      if (first.total > limits.MAX_ITEMS) throw new ScanIncomplete("too_large");
      const rows = [...first.items];
      let lastTotal = first.total;
      for (let page = 2; page <= first.pages; page += 1) {
        const next = await call(() =>
          client.listItems(route, { page, ...selector }),
        );
        rows.push(...next.items);
        lastTotal = next.total;
      }
      if (lastTotal === first.total && rows.length >= lastTotal) return rows;
    }
    throw new ScanIncomplete("unstable");
  }

  async function readRoute(
    route: GhostItemRoute,
    routeScope: RouteScope,
  ): Promise<void> {
    if (routeScope.all) {
      for (const item of await readList(route, {})) admit(item);
      return;
    }
    for (const tagIds of chunk(routeScope.tagIds, ID_BATCH)) {
      for (const item of await readList(route, { tagIds })) admit(item);
    }
    for (const batch of chunk(routeScope.ids, ID_BATCH)) {
      for (const item of await readList(route, { ids: batch })) admit(item);
    }
  }

  async function run(): Promise<GhostScanPage> {
    await readRoute("posts", scope.posts);
    await readRoute("pages", scope.pages);

    const items: ConnectorItem[] = [];
    let skipped = 0;
    for (const item of found.values()) {
      if (!item.access) {
        skipped += 1;
        continue;
      }
      items.push(toConnectorItem(item, siteHost));
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
      warnings: skipped > 0 ? [`${SCAN_SKIPPED_WARNING} ${skipped}`] : [],
    };
  }

  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ScanIncomplete)) throw error;
    return {
      items: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
      warnings: [
        error.reason === "unstable"
          ? SCAN_UNSTABLE_WARNING
          : SCAN_NARROW_WARNING,
      ],
    };
  }
}

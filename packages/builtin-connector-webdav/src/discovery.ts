import { createHash } from "node:crypto";
import { classifySourceFile } from "@sourceweft/builtin-document-parsers/file-types";
import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { DavClient, DavEntry } from "./dav-client";
import { normalizeEtag } from "./etag";
import { WebDavError } from "./errors";
import { webdavFlavor, type WebDavFlavor } from "./flavor";
import { MAX_DEPTH, MAX_ENTRIES, SCAN_TIMEOUT_MS } from "./limits";
import { isStrictDescendant, samePath, toExternalId } from "./paths";

export type DiscoveryLimits = {
  /** Deepest collection level below a root the walk descends into. */
  maxDepth: number;
  /** Files and collections visited before the walk stops, incomplete. */
  maxEntries: number;
  /** Wall-clock budget for the whole walk. */
  scanTimeoutMs: number;
};

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxDepth: MAX_DEPTH,
  maxEntries: MAX_ENTRIES,
  scanTimeoutMs: SCAN_TIMEOUT_MS,
};

export type DiscoveryOptions = {
  client: DavClient;
  endpoint: URL;
  /** Normalized roots (each a decoded path with a trailing slash). */
  roots: string[];
  /** The flavor that derives item identity/metadata and decides readability,
   * and whose `extraProps` the depth-1 listings request. Defaults to the plain
   * WebDAV flavor. */
  flavor?: WebDavFlavor;
  /** The canonical server URL from config, passed through to the flavor's item
   * identity. Absent for plain WebDAV. */
  server?: string;
  limits?: Partial<DiscoveryLimits>;
  now?: () => number;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
};

const GENERIC_MIME = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** The decoded file name from a canonical externalId (`/a/b.txt` -> `b.txt`). */
function lastSegment(externalId: string): string {
  const segments = externalId.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? "";
}

/** A collection externalId (no trailing slash) as a collection request path. */
function asCollectionPath(externalId: string): string {
  return externalId.endsWith("/") ? externalId : `${externalId}/`;
}

/**
 * The item's MIME type: the server's `getcontenttype` when it is a real type,
 * otherwise the type inferred from the file extension (the same classifier the
 * rest of the platform uses), and `application/octet-stream` as a last resort.
 */
function discoveryMimeType(name: string, contentType: string | null): string {
  const normalized =
    (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!GENERIC_MIME.has(normalized)) return normalized;
  const classification = classifySourceFile({ fileName: name });
  return classification.supported
    ? classification.mimeType
    : "application/octet-stream";
}

/**
 * The normalised `getetag` when the server supplied one (so a quoting, weak- or
 * content-coding difference between servers or between PROPFIND and GET does not
 * change the hash spuriously), otherwise a stable digest of the size and
 * last-modified date. When the server supplied none of etag, size or
 * last-modified there is nothing stable to hash, so the hash is null and the
 * orchestrator treats the item as changed on every run (re-indexed, never
 * wrongly deduplicated).
 */
function contentHashOf(entry: DavEntry): string | null {
  const etag = normalizeEtag(entry.etag);
  if (etag !== null) return etag;
  if (entry.contentLength === null && entry.lastModified === null) return null;
  const size = entry.contentLength === null ? "" : String(entry.contentLength);
  const modified =
    entry.lastModified === null ? "" : entry.lastModified.toISOString();
  return createHash("sha256").update(`${size}|${modified}`).digest("hex");
}

/** One discovered file as a `ConnectorItem`, or `null` when the flavor assigns
 * it no stable identity (e.g. a Nextcloud file with no file id), in which case
 * the caller skips it like an unreadable file. The item id, URI and metadata
 * come from the flavor (for plain WebDAV: the decoded path, the rebuilt request
 * URL and `{ path, etag }`); the title, type, size, timestamp and content hash
 * are derived from the decoded path and the entry the same way for every
 * flavor. */
function toItem(
  flavor: WebDavFlavor,
  endpoint: URL,
  server: string | undefined,
  relativePath: string,
  entry: DavEntry,
): ConnectorItem | null {
  const name = lastSegment(relativePath);
  const identity = flavor.itemIdentity(entry, {
    endpoint,
    server,
    relativePath,
  });
  if (identity === null) return null;
  return {
    externalId: identity.externalId,
    externalUri: identity.externalUri,
    title: name,
    mimeType: discoveryMimeType(name, entry.contentType),
    sizeBytes: entry.contentLength,
    externalUpdatedAt: entry.lastModified,
    contentHash: contentHashOf(entry),
    metadata: identity.metadata,
  };
}

/**
 * Breadth-first walk of the selected roots, one `PROPFIND` depth-1 request per
 * collection, emitting a page of files per collection. A soft failure — depth,
 * entry-count or time caps, a 403/404 on a non-root subcollection, a listing
 * that omits its own collection entry, a per-resource error inside a listing,
 * or a listing whose only children fell outside the scope — marks the walk
 * incomplete but lets the rest of it finish and never archives: the final page
 * is `complete: true, reconcileMissing: false`, so the run succeeds and nothing
 * that still exists is deleted, while the next run retries. Only a fully clean
 * walk emits `complete: true, reconcileMissing: true` so disappeared files are
 * reconciled. Every href is mapped through `toExternalId` first: an entry that
 * escapes the endpoint, lands on another origin or decodes badly is dropped.
 *
 * The time cap counts only the wall-clock spent inside PROPFIND requests, not
 * the orchestrator's extract/embed time between the generator's pulls, so a
 * slow pipeline over a small tree is never cut short.
 *
 * A 401 (and any error other than a 403/404) propagates to the caller, which
 * maps it to the account-reconnect condition; this walk never surfaces a raw
 * HTTP status.
 */
export async function* discoverWebDavPages(
  options: DiscoveryOptions,
): AsyncGenerator<ConnectorDiscoveryPage> {
  const { client, endpoint, roots, logger } = options;
  const flavor = options.flavor ?? webdavFlavor;
  const server = options.server;
  const now = options.now ?? Date.now;
  const limits: DiscoveryLimits = {
    ...DEFAULT_DISCOVERY_LIMITS,
    ...options.limits,
  };

  const seen = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [];
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root);
      queue.push({ path: root, depth: 0 });
    }
  }

  // Every item externalId emitted so far in this scan (across pages and roots).
  // A flavor whose identity is not path-based (Nextcloud: `nc:<fileId>`) can
  // reach the same id by two in-scope paths — an internal share or an external
  // mount listed twice, or a hostile server echoing one file id on two hrefs —
  // and must still emit that item only once.
  const emittedIds = new Set<string>();
  let duplicateItems = 0;
  let entryCount = 0;
  let incomplete = false;
  let outOfScope = 0;
  let subtreesSkipped = 0;
  let droppedResponses = 0;
  let selfMissing = 0;
  let unmatchedListings = 0;
  // Only PROPFIND time counts toward the scan budget; the generator is pulled
  // lazily, so wall clock between pulls includes extract/embed work.
  let propfindMs = 0;

  while (queue.length > 0) {
    if (propfindMs > limits.scanTimeoutMs) {
      incomplete = true;
      break;
    }
    const current = queue.shift()!;

    const stats = { dropped: 0 };
    let entries: DavEntry[];
    const requestStart = now();
    try {
      entries = await client.propfind(current.path, 1, {
        stats,
        extraProps: flavor.extraProps,
      });
    } catch (error) {
      propfindMs += now() - requestStart;
      if (
        error instanceof WebDavError &&
        (error.code === "WEBDAV_FORBIDDEN" || error.code === "WEBDAV_NOT_FOUND")
      ) {
        // A single unreadable or missing subtree does not fail the whole run,
        // but it does mean nothing may be archived from it. The fixed code is
        // the only thing logged.
        incomplete = true;
        subtreesSkipped += 1;
        logger?.warn?.("webdav_scan_subtree_skipped", { reason: error.code });
        continue;
      }
      throw error;
    }
    propfindMs += now() - requestStart;

    if (stats.dropped > 0) {
      // The server named one or more resources it could not describe (an RFC
      // 4918 per-resource 403/423): the listing did not fully cover the
      // collection, so it is not authoritative for reconciliation.
      incomplete = true;
      droppedResponses += stats.dropped;
    }

    const items: ConnectorItem[] = [];
    let capped = false;
    let selfSeen = false;
    let childEntries = 0;
    let inScopeChildren = 0;
    for (const entry of entries) {
      // The decoded path relative to the endpoint. Scope, traversal and
      // extract stay keyed off this path for every flavor, even when a flavor's
      // own item identity (externalId/externalUri) is not path-based.
      const relativePath = toExternalId(endpoint, entry.href);
      if (relativePath !== null && samePath(relativePath, current.path)) {
        // The collection's own self entry: expected, not a child, not an item.
        selfSeen = true;
        continue;
      }
      // Any other response is a child the server listed for this collection.
      childEntries += 1;
      if (relativePath === null) continue;
      if (!isStrictDescendant(current.path, relativePath)) {
        // Only entries strictly below the listed collection (and therefore
        // below a selected root) are in scope. A parent, sibling or any path
        // the server lists outside the collection is dropped and counted, so a
        // hostile or buggy server cannot pull files outside the chosen roots
        // into scope.
        outOfScope += 1;
        continue;
      }
      inScopeChildren += 1;
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        incomplete = true;
        capped = true;
        break;
      }
      if (entry.isCollection) {
        const childDepth = current.depth + 1;
        if (childDepth > limits.maxDepth) {
          incomplete = true;
          continue;
        }
        const childPath = asCollectionPath(relativePath);
        if (!seen.has(childPath)) {
          seen.add(childPath);
          queue.push({ path: childPath, depth: childDepth });
        }
      } else if (flavor.isReadable(entry)) {
        const item = toItem(flavor, endpoint, server, relativePath, entry);
        if (item !== null) {
          if (emittedIds.has(item.externalId)) {
            // The same identity reached by a second in-scope path: emit it once
            // (first by walk order wins). A duplicate is expected for shared or
            // mounted subtrees, so it does not make the scan incomplete.
            duplicateItems += 1;
          } else {
            emittedIds.add(item.externalId);
            items.push(item);
          }
        }
      }
      // A file the flavor reports as unreadable, or assigns no stable identity
      // to, is simply not indexed. It was listed and is in scope, so it does not
      // make the scan incomplete.
    }

    if (!capped) {
      if (!selfSeen) {
        // A listing that omits the collection's own entry (an empty or
        // self-less 207) cannot be trusted to have enumerated its children:
        // treating it as an empty collection would archive files that exist.
        incomplete = true;
        selfMissing += 1;
      }
      if (childEntries > 0 && inScopeChildren === 0) {
        // The server returned children but none matched the requested scope (a
        // case- or NFC-mismatched listing): nothing here is authoritative.
        incomplete = true;
        unmatchedListings += 1;
      }
    }

    if (items.length > 0) {
      yield {
        items,
        continuation: { collectionsVisited: seen.size },
        checkpoint: null,
        complete: false,
        reconcileMissing: false,
      };
    }
    if (capped) break;
  }

  if (outOfScope > 0) {
    // Common and not itself fatal (servers that echo parents/siblings): a
    // fixed-message warning with only a count.
    logger?.warn?.("webdav_scan_out_of_scope_entries", { count: outOfScope });
  }
  if (duplicateItems > 0) {
    // In-scope paths that resolved to an already-emitted identity: one
    // fixed-message warning with only a count, never per item. Not fatal and
    // never marks the scan incomplete.
    logger?.warn?.("webdav_scan_duplicate_items", { count: duplicateItems });
  }
  if (droppedResponses > 0) {
    logger?.warn?.("webdav_scan_dropped_responses", {
      count: droppedResponses,
    });
  }
  if (selfMissing > 0) {
    logger?.warn?.("webdav_scan_self_missing", { count: selfMissing });
  }
  if (unmatchedListings > 0) {
    logger?.warn?.("webdav_scan_unmatched_listings", {
      count: unmatchedListings,
    });
  }

  if (incomplete) {
    // The scan did not fully cover the roots, so it finishes as a succeeded run
    // that archives nothing (reconcileMissing:false) and is retried next time.
    logger?.warn?.("webdav_scan_incomplete", {
      subtreesSkipped,
      droppedResponses,
      selfMissing,
      unmatchedListings,
    });
    yield {
      items: [],
      continuation: null,
      checkpoint: null,
      complete: true,
      reconcileMissing: false,
    };
    return;
  }

  yield {
    items: [],
    continuation: null,
    checkpoint: null,
    complete: true,
    reconcileMissing: true,
  };
}

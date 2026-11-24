import { createHash } from "node:crypto";
import { classifySourceFile } from "@sourceweft/builtin-document-parsers/file-types";
import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { DavClient, DavEntry } from "./dav-client";
import { WebDavError } from "./errors";
import { MAX_DEPTH, MAX_ENTRIES, SCAN_TIMEOUT_MS } from "./limits";
import {
  isStrictDescendant,
  samePath,
  toExternalId,
  toRequestUrl,
} from "./paths";

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

/** `getetag` when the server supplied one, otherwise a stable digest of the
 * size and last-modified date, so an unchanged file keeps the same hash. */
function contentHashOf(entry: DavEntry): string {
  if (entry.etag !== null) return entry.etag;
  const size = entry.contentLength === null ? "" : String(entry.contentLength);
  const modified =
    entry.lastModified === null ? "" : entry.lastModified.toISOString();
  return createHash("sha256").update(`${size}|${modified}`).digest("hex");
}

/** One discovered file as a `ConnectorItem`. The request URL is always rebuilt
 * from the validated, decoded path, never from the raw server href. */
function toItem(
  endpoint: URL,
  externalId: string,
  entry: DavEntry,
): ConnectorItem {
  const name = lastSegment(externalId);
  return {
    externalId,
    externalUri: toRequestUrl(endpoint, externalId),
    title: name,
    mimeType: discoveryMimeType(name, entry.contentType),
    sizeBytes: entry.contentLength,
    externalUpdatedAt: entry.lastModified,
    contentHash: contentHashOf(entry),
    metadata: { path: externalId, etag: entry.etag },
  };
}

/**
 * Breadth-first walk of the selected roots, one `PROPFIND` depth-1 request per
 * collection, emitting a page of files per collection. Depth, entry-count and
 * wall-clock caps and a 403/404 on a non-root subcollection all mark the walk
 * incomplete but let the rest of it finish; only a fully successful walk emits
 * a final `complete: true, reconcileMissing: true` page, so a truncated walk
 * never causes files that still exist to be archived. Every href is mapped
 * through `toExternalId` first: an entry that escapes the endpoint, lands on
 * another origin or decodes badly is dropped.
 *
 * A 401 (and any error other than a 403/404) propagates to the caller, which
 * maps it to the account-reconnect condition; this walk never surfaces a raw
 * HTTP status.
 */
export async function* discoverWebDavPages(
  options: DiscoveryOptions,
): AsyncGenerator<ConnectorDiscoveryPage> {
  const { client, endpoint, roots, logger } = options;
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

  let entryCount = 0;
  let incomplete = false;
  let outOfScope = 0;
  const start = now();

  while (queue.length > 0) {
    if (now() - start > limits.scanTimeoutMs) {
      incomplete = true;
      break;
    }
    const current = queue.shift()!;

    let entries: DavEntry[];
    try {
      entries = await client.propfind(current.path, 1);
    } catch (error) {
      if (
        error instanceof WebDavError &&
        (error.code === "WEBDAV_FORBIDDEN" || error.code === "WEBDAV_NOT_FOUND")
      ) {
        // A single unreadable or missing subtree does not fail the whole run,
        // but it does mean nothing may be archived from it. The fixed code is
        // the only thing logged.
        incomplete = true;
        logger?.warn?.("webdav_scan_subtree_skipped", { reason: error.code });
        continue;
      }
      throw error;
    }

    const items: ConnectorItem[] = [];
    let capped = false;
    for (const entry of entries) {
      const externalId = toExternalId(endpoint, entry.href);
      if (externalId === null) continue;
      if (!isStrictDescendant(current.path, externalId)) {
        // Only entries strictly below the listed collection (and therefore
        // below a selected root) are in scope. The collection's own self entry
        // is expected and ignored; a parent, sibling or any path the server
        // lists outside the collection is dropped and counted, so a hostile or
        // buggy server cannot pull files outside the chosen roots into scope.
        if (!samePath(externalId, current.path)) outOfScope += 1;
        continue;
      }
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
        const childPath = asCollectionPath(externalId);
        if (!seen.has(childPath)) {
          seen.add(childPath);
          queue.push({ path: childPath, depth: childDepth });
        }
      } else {
        items.push(toItem(endpoint, externalId, entry));
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
    // Common and not an error (self entries, servers that echo parents): one
    // fixed-message warning with only a count, and the scan is still treated
    // as authoritative for the roots it did cover.
    logger?.warn?.("webdav_scan_out_of_scope_entries", { count: outOfScope });
  }

  if (incomplete) {
    logger?.warn?.("webdav_scan_incomplete", { warning: "scan_incomplete" });
    yield {
      items: [],
      continuation: null,
      checkpoint: null,
      complete: false,
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

import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import type { ZoteroClient } from "./client";
import { ZoteroError } from "./errors";
import {
  MAX_OBJECTS,
  MAX_REQUESTS,
  MAX_RESTARTS,
  SCAN_TIMEOUT_MS,
  SHORTCUT_MAX_AGE_MS,
} from "./limits";
import {
  buildCollectionTree,
  groupLibrary,
  inScope,
  parseCollection,
  parseItem,
  toConnectorItem,
  type ZoteroCollection,
  type ZoteroObject,
} from "./model";

/** The caps one scan enforces; each defaults to the matching package limit. */
export type ScanLimits = {
  /** Objects (collections and items) one attempt may read. */
  MAX_OBJECTS: number;
  /** HTTP requests the whole scan, restarts included, may make. */
  MAX_REQUESTS: number;
  /** Restarts after the library version changed mid-scan. */
  MAX_RESTARTS: number;
  /** Wall-clock budget of the whole scan. */
  SCAN_TIMEOUT_MS: number;
};

export type ScanCheckpoint = { libraryVersion: number; checkedAt: number };

export type ScanLibraryInput = {
  client: ZoteroClient;
  libraryType: "user" | "group";
  libraryId: string;
  /** Empty means the whole library. */
  selectedCollectionKeys: string[];
  cursor:
    | {
        committed?: {
          libraryVersion?: number;
          checkedAt?: number;
        } | null;
      }
    | null
    | undefined;
  now?: () => number;
  limits?: Partial<ScanLimits>;
  /** Receives a fixed event name and a reason string only. */
  logger?: {
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

type IncompleteReason = "unstable" | "too_large" | "timeout";

/** Thrown inside a scan when it must give up without raising a platform error. */
class ScanIncomplete extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
    this.name = "ScanIncomplete";
  }
}

/** Thrown inside a scan when the library moved and the attempt must restart. */
class ScanRestart extends Error {
  constructor() {
    super("restart");
    this.name = "ScanRestart";
  }
}

const DEFAULTS: ScanLimits = {
  MAX_OBJECTS,
  MAX_REQUESTS,
  MAX_RESTARTS,
  SCAN_TIMEOUT_MS,
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Scans a Zotero library and yields exactly one final page. A complete,
 * version-consistent scan reconciles (`reconcileMissing: true`); a cached
 * checkpoint that is still fresh and unchanged short-circuits to one request;
 * a scan that cannot finish within its caps or keeps racing library writes
 * yields an empty, non-reconciling page with no checkpoint, so nothing is
 * archived on partial data. Fatal Zotero errors propagate.
 */
export async function* scanLibrary(
  input: ScanLibraryInput,
): AsyncGenerator<ConnectorDiscoveryPage> {
  const now = input.now ?? Date.now;
  const limits: ScanLimits = { ...DEFAULTS, ...input.limits };
  const { client } = input;
  const deadline = now() + limits.SCAN_TIMEOUT_MS;
  let requests = 0;

  /** Every request goes through here so the caps hold across restarts. */
  async function fetchPage(
    path: "collections" | "items",
    options: { start: number; ifModifiedSinceVersion?: number },
  ) {
    if (now() >= deadline) throw new ScanIncomplete("timeout");
    if (requests >= limits.MAX_REQUESTS) throw new ScanIncomplete("too_large");
    requests += 1;
    try {
      return await client.getPage(path, options);
    } catch (error) {
      if (error instanceof ZoteroError && error.code === "ZOTERO_TOO_LARGE") {
        throw new ScanIncomplete("too_large");
      }
      throw error;
    }
  }

  const incomplete = (reason: IncompleteReason): ConnectorDiscoveryPage => {
    input.logger?.warn?.("zotero_scan_incomplete", { reason });
    return {
      items: [],
      deletedExternalIds: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    };
  };

  // Rule 1: the shortcut.
  const committed = input.cursor?.committed;
  let prefetched: {
    libraryVersion: number;
    totalResults: number;
    objects: unknown[];
  } | null = null;
  if (
    committed &&
    isCount(committed.libraryVersion) &&
    isCount(committed.checkedAt)
  ) {
    const age = now() - committed.checkedAt;
    if (age >= 0 && age < SHORTCUT_MAX_AGE_MS) {
      let first;
      try {
        first = await fetchPage("items", {
          start: 0,
          ifModifiedSinceVersion: committed.libraryVersion,
        });
      } catch (error) {
        if (error instanceof ScanIncomplete) {
          yield incomplete(error.reason);
          return;
        }
        throw error;
      }
      if (first.status === "not_modified") {
        yield {
          items: [],
          deletedExternalIds: [],
          complete: true,
          reconcileMissing: false,
          checkpoint: {
            libraryVersion: committed.libraryVersion,
            checkedAt: committed.checkedAt,
          },
        };
        return;
      }
      // The library moved on: this page is the first page of the full scan.
      prefetched = first;
    }
  }

  for (let attempt = 0; attempt <= limits.MAX_RESTARTS; attempt += 1) {
    try {
      const page = await scanOnce(prefetched);
      yield page;
      return;
    } catch (error) {
      if (error instanceof ScanRestart) {
        prefetched = null;
        continue;
      }
      if (error instanceof ScanIncomplete) {
        yield incomplete(error.reason);
        return;
      }
      throw error;
    }
  }
  yield incomplete("unstable");

  async function scanOnce(
    first: typeof prefetched,
  ): Promise<ConnectorDiscoveryPage> {
    let objectCount = 0;
    let libraryVersion: number | null = null;
    const versions = new Set<number>();

    /** Reads every page of one endpoint; the first page may be supplied. */
    async function readAll(
      path: "collections" | "items",
      supplied: typeof prefetched,
    ): Promise<unknown[]> {
      const all: unknown[] = [];
      let start = 0;
      let page = supplied;
      for (;;) {
        if (!page) {
          const reply = await fetchPage(path, { start });
          // `not_modified` is only possible when we sent a version.
          if (reply.status !== "ok")
            throw new ZoteroError("ZOTERO_BAD_RESPONSE");
          page = reply;
        }
        versions.add(page.libraryVersion);
        if (path === "items") libraryVersion ??= page.libraryVersion;
        // Collections are read first, so the first items page is where the
        // two endpoints are compared; every later page must match too.
        if (versions.size > 1) throw new ScanRestart();
        objectCount += page.objects.length;
        if (
          page.totalResults > limits.MAX_OBJECTS ||
          objectCount > limits.MAX_OBJECTS
        ) {
          throw new ScanIncomplete("too_large");
        }
        all.push(...page.objects);
        start += page.objects.length;
        if (start >= page.totalResults) return all;
        // The server promised more than it served: stop rather than loop.
        if (page.objects.length === 0) {
          throw new ZoteroError("ZOTERO_BAD_RESPONSE");
        }
        page = null;
      }
    }

    // Collections first, then items; every page must share one library version.
    const rawCollections = await readAll("collections", null);
    const rawItems = await readAll("items", first);
    if (libraryVersion === null) throw new ZoteroError("ZOTERO_BAD_RESPONSE");

    const collections: ZoteroCollection[] = [];
    for (const raw of rawCollections) {
      const parsed = parseCollection(raw);
      if (parsed) collections.push(parsed);
    }
    const objects: ZoteroObject[] = [];
    for (const raw of rawItems) {
      const parsed = parseItem(raw);
      if (parsed) objects.push(parsed);
    }

    const tree = buildCollectionTree(collections);
    const expanded =
      input.selectedCollectionKeys.length === 0
        ? null
        : tree.expand(input.selectedCollectionKeys);
    const items: ConnectorItem[] = [];
    for (const group of groupLibrary(objects).parents) {
      if (!inScope(group, expanded)) continue;
      const collectionPaths = group.item.collections.map((key) =>
        tree.pathOf(key),
      );
      items.push(
        toConnectorItem(
          group,
          input.libraryType,
          input.libraryId,
          collectionPaths,
        ),
      );
    }

    return {
      items,
      deletedExternalIds: [],
      complete: true,
      reconcileMissing: true,
      checkpoint: { libraryVersion, checkedAt: now() },
    };
  }
}

import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
} from "@sourceweft/contracts";
import { invalidRequestError } from "./adapter-error";
import type { ZoteroClient } from "./client";
import { ZOTERO_KEY_PATTERN } from "./contribution";
import { ZoteroError } from "./errors";
import { MAX_OBJECTS, MAX_SELECTED_COLLECTIONS } from "./limits";
import {
  buildCollectionTree,
  parseCollection,
  type CollectionTree,
  type ZoteroCollection,
} from "./model";

const KEY = new RegExp(ZOTERO_KEY_PATTERN);
/** Entries one browse result holds (the selection contract's own bound). */
const BROWSE_MAX_ENTRIES = 500;
/** Ancestors one browse result holds (the selection contract's own bound). */
const BROWSE_MAX_BREADCRUMBS = 50;
const NAME_MAX = 1024;
const DETAIL_MAX = 2048;

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

type Listing = {
  byKey: Map<string, ZoteroCollection>;
  tree: CollectionTree;
};

/**
 * Reads every collection of the library (paged, bounded by the client's own
 * request cap and {@link MAX_OBJECTS}). An unreadable collection fails the
 * call: dropping it would silently hide its subtree.
 */
async function listCollections(client: ZoteroClient): Promise<Listing> {
  const collections: ZoteroCollection[] = [];
  let seen = 0;
  for (let start = 0; ;) {
    const page = await client.getPage("collections", { start });
    if (page.status !== "ok") throw new ZoteroError("ZOTERO_BAD_RESPONSE");
    if (page.objects.length > page.totalResults - start) {
      throw new ZoteroError("ZOTERO_BAD_RESPONSE");
    }
    seen += page.objects.length;
    if (page.totalResults > MAX_OBJECTS || seen > MAX_OBJECTS) {
      throw new ZoteroError("ZOTERO_TOO_LARGE");
    }
    for (const raw of page.objects) {
      const parsed = parseCollection(raw);
      if (!parsed) throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      collections.push(parsed);
    }
    start += page.objects.length;
    if (start >= page.totalResults) break;
    // The server promised more than it served: stop rather than loop.
    if (page.objects.length === 0) throw new ZoteroError("ZOTERO_BAD_RESPONSE");
  }
  const byKey = new Map<string, ZoteroCollection>();
  for (const collection of collections) {
    if (!byKey.has(collection.key)) byKey.set(collection.key, collection);
  }
  return { byKey, tree: buildCollectionTree(collections) };
}

function entryFor(
  collection: ZoteroCollection,
  tree: CollectionTree,
): ConnectorSelectionEntry {
  return {
    id: collection.key,
    kind: "collection",
    name: truncate(collection.name, NAME_MAX),
    detail: null,
    selectable: true,
    expandable: tree.children(collection.key).length > 0,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

/** The ancestors strictly above `collection`, outermost first; innermost 50. */
function breadcrumbsFor(
  collection: ZoteroCollection,
  byKey: Map<string, ZoteroCollection>,
): Array<{ id: string; name: string }> {
  const chain: ZoteroCollection[] = [];
  const visited = new Set<string>([collection.key]);
  let parentKey = collection.parent;
  while (parentKey !== null && !visited.has(parentKey)) {
    const parent = byKey.get(parentKey);
    if (!parent) break;
    visited.add(parent.key);
    chain.unshift(parent);
    parentKey = parent.parent;
  }
  return chain
    .slice(-BROWSE_MAX_BREADCRUMBS)
    .map(({ key, name }) => ({ id: key, name: truncate(name, NAME_MAX) }));
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString(
    "base64url",
  );
}

/** Strict inverse of {@link encodeCursor}; any other shape is an invalid request. */
function decodeCursor(cursor: string, total: number): number {
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw invalidRequestError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidRequestError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidRequestError();
  }
  const record = parsed as Record<string, unknown>;
  const offset = record.o;
  if (
    Object.keys(record).length !== 1 ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > total
  ) {
    throw invalidRequestError();
  }
  return offset;
}

/**
 * `zotero.browse`: the child collections of a container (the library's
 * top-level collections when no `containerId` is given), sorted by name, at
 * most 500 per call with an opaque offset cursor.
 */
export async function browseCollections(input: {
  client: ZoteroClient;
  request: Record<string, unknown>;
}): Promise<ConnectorSelectionBrowseResult> {
  const { containerId, cursor } = input.request;
  if (
    containerId !== undefined &&
    containerId !== null &&
    (typeof containerId !== "string" || !KEY.test(containerId))
  ) {
    throw invalidRequestError();
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw invalidRequestError();
  }

  const { byKey, tree } = await listCollections(input.client);
  const container =
    typeof containerId === "string" ? (byKey.get(containerId) ?? null) : null;
  if (typeof containerId === "string" && !container) {
    throw invalidRequestError();
  }

  const children = tree.children(container?.key ?? null);
  const offset =
    cursor === undefined || cursor === ""
      ? 0
      : decodeCursor(cursor, children.length);
  const end = offset + BROWSE_MAX_ENTRIES;
  const hasMore = end < children.length;
  return {
    container: container
      ? {
          id: container.key,
          kind: "collection",
          name: truncate(container.name, NAME_MAX),
          detail: null,
        }
      : null,
    breadcrumbs: container ? breadcrumbsFor(container, byKey) : [],
    entries: children.slice(offset, end).map((child) => entryFor(child, tree)),
    cursor: hasMore ? encodeCursor(end) : "",
    hasMore,
    helpLink: null,
  };
}

/**
 * `zotero.describe`: for each requested key, in request order, whether the
 * collection still exists and its name and path. A duplicate id answers twice.
 */
export async function describeCollections(input: {
  client: ZoteroClient;
  request: Record<string, unknown>;
}): Promise<ConnectorSelectionDescribeResult> {
  const { ids } = input.request;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_SELECTED_COLLECTIONS ||
    !ids.every((id): id is string => typeof id === "string" && KEY.test(id))
  ) {
    throw invalidRequestError();
  }
  const { byKey, tree } = await listCollections(input.client);
  const items: ConnectorSelectionDescribeItem[] = ids.map((id) => {
    const collection = byKey.get(id);
    if (!collection) {
      return {
        id,
        kind: null,
        name: null,
        detail: null,
        exists: false,
        meta: {},
      };
    }
    return {
      id,
      kind: "collection",
      name: truncate(collection.name, NAME_MAX),
      detail: truncate(tree.pathOf(id), DETAIL_MAX),
      exists: true,
      meta: {},
    };
  });
  return { items };
}

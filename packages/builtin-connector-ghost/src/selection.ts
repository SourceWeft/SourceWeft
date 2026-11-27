import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { invalidRequestError } from "./adapter-error";
import type { GhostClient, GhostItemRoute } from "./client";
import { MAX_TAG_PAGES, PAGE_SIZE } from "./limits";
import {
  isoOf,
  titleOf,
  type GhostContentType,
  type GhostListItem,
  type GhostTag,
} from "./model";

/** The selection contract's own per-result bound on entries. */
const BROWSE_MAX_ENTRIES = 500;
/** The contract's bound on an entry name. */
const NAME_MAX = 1024;
/** The search query bound (matches the contribution's `maxLength`). */
const QUERY_MAX = 200;
/** The cursor bound (matches the contribution's `maxLength`). */
const CURSOR_MAX = 4096;
/** The describe `ids` bound (matches the contribution's `maxItems`). */
const DESCRIBE_MAX_IDS = 100;
/** Past this a cursor can never be valid (100 tags a page, 100,000 pages). */
const MAX_OFFSET = 10_000_000;
const MAX_PAGE = 100_000;

const DESCRIBE_ID = /^(?:type:(post|page)|(tag|post|page):([0-9a-f]{24}))$/;

/** What every selection action receives: a client (its signal carries the
 * action deadline) and the request as the platform validated it. */
export type SelectionContext = {
  client: GhostClient;
  request: Record<string, unknown>;
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeCursor(value: Record<string, number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Strict inverse of {@link encodeCursor}: exactly the named integer fields,
 * each within its bound, nothing else. An empty or absent cursor is `null`.
 */
function decodeCursor(
  cursor: unknown,
  fields: Record<string, { min: number; max: number }>,
): Record<string, number> | null {
  if (cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > CURSOR_MAX) {
    throw invalidRequestError();
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw invalidRequestError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidRequestError();
  }
  const names = Object.keys(fields);
  if (!isRecord(parsed) || Object.keys(parsed).length !== names.length) {
    throw invalidRequestError();
  }
  const out: Record<string, number> = {};
  for (const name of names) {
    const value = parsed[name];
    const bound = fields[name] as { min: number; max: number };
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < bound.min ||
      value > bound.max
    ) {
      throw invalidRequestError();
    }
    out[name] = value;
  }
  return out;
}

const typeEntry = (type: GhostContentType): ConnectorSelectionEntry => ({
  id: `type:${type}`,
  kind: "type",
  name: type === "post" ? "All posts" : "All pages",
  detail: null,
  selectable: true,
  expandable: false,
  disabledReason: null,
  size: null,
  modifiedAt: null,
});

/** A tag's display name: its name, or its slug when it has none. */
const tagName = (tag: GhostTag): string =>
  truncate(tag.name === "" ? tag.slug : tag.name, NAME_MAX);

const tagEntry = (tag: GhostTag): ConnectorSelectionEntry => ({
  id: `tag:${tag.id}`,
  kind: "tag",
  name: tagName(tag),
  detail: null,
  selectable: true,
  // Tags are flat: there is no container below the root.
  expandable: false,
  disabledReason: null,
  size: null,
  modifiedAt: null,
});

/**
 * `ghost.browse`: the root only. The first result opens with "All posts" and
 * "All pages", then the site's tags in id order; tags are flat, so there is
 * no container to open. One call reads at most {@link MAX_TAG_PAGES} tag pages
 * and returns at most 500 entries; a longer tag list continues through an
 * opaque offset cursor, so nothing is silently cut.
 */
export async function browseSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionBrowseResult> {
  const { client, request } = context;
  const { containerId } = request;
  if (containerId !== undefined && containerId !== null) {
    throw invalidRequestError();
  }
  const decoded = decodeCursor(request.cursor, {
    o: { min: 0, max: MAX_OFFSET },
  });
  const offset = decoded?.o ?? 0;
  const entries: ConnectorSelectionEntry[] = [];
  if (offset === 0) entries.push(typeEntry("post"), typeEntry("page"));
  const capacity = BROWSE_MAX_ENTRIES - entries.length;

  const tags: GhostTag[] = [];
  let hasMore = false;
  const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
  for (let read = 0; read < MAX_TAG_PAGES; read += 1) {
    const page = firstPage + read;
    const result = await client.listTags(page);
    // The tags of this page that come at or after the offset.
    const skip = Math.max(0, offset - (page - 1) * PAGE_SIZE);
    const rows = result.tags.slice(skip);
    const room = capacity - tags.length;
    tags.push(...rows.slice(0, room));
    if (rows.length > room) {
      hasMore = true;
      break;
    }
    if (page >= result.pages) break;
    // Pages remain but this call has read its share.
    if (read === MAX_TAG_PAGES - 1) hasMore = true;
  }
  // A site that promises more than it serves must not loop the caller.
  if (tags.length === 0) hasMore = false;

  entries.push(...tags.map(tagEntry));
  return {
    container: null,
    breadcrumbs: [],
    entries,
    cursor: hasMore ? encodeCursor({ o: offset + tags.length }) : "",
    hasMore,
    helpLink: null,
  };
}

const routeOf = (type: GhostContentType): GhostItemRoute =>
  type === "page" ? "pages" : "posts";

const searchEntry = (item: GhostListItem): ConnectorSelectionEntry => ({
  id: `${item.type}:${item.id}`,
  kind: item.type,
  name: truncate(titleOf(item), NAME_MAX),
  detail: null,
  selectable: true,
  expandable: false,
  disabledReason: null,
  size: null,
  modifiedAt: isoOf(item.updatedAt),
});

/**
 * `ghost.search`: posts and pages whose title contains the query, as
 * kind-qualified entries (posts first). One call reads page N of each list; the
 * opaque cursor carries N and the page counts the lists reported, so a list
 * that has run out is not asked again. The title filter is built (and its
 * quotes and backslashes escaped) by the client.
 */
export async function searchSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionSearchResult> {
  const { client, request } = context;
  const query = request.query;
  if (typeof query !== "string") throw invalidRequestError();
  const text = query.trim();
  if (text.length < 1 || text.length > QUERY_MAX) throw invalidRequestError();
  const decoded = decodeCursor(request.cursor, {
    p: { min: 1, max: MAX_PAGE },
    a: { min: 0, max: MAX_PAGE },
    b: { min: 0, max: MAX_PAGE },
  });
  const page = decoded?.p ?? 1;
  let postPages = decoded?.a ?? 1;
  let pagePages = decoded?.b ?? 1;

  const hits: GhostListItem[] = [];
  if (page <= postPages) {
    const posts = await client.searchContent(text, routeOf("post"), page);
    hits.push(...posts.items);
    postPages = posts.pages;
  }
  if (page <= pagePages) {
    const pages = await client.searchContent(text, routeOf("page"), page);
    hits.push(...pages.items);
    pagePages = pages.pages;
  }
  const entries: ConnectorSelectionEntry[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (entries.length >= BROWSE_MAX_ENTRIES) break;
    const entry = searchEntry(hit);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  const hasMore = page < postPages || page < pagePages;
  return {
    entries,
    cursor: hasMore
      ? encodeCursor({ p: page + 1, a: postPages, b: pagePages })
      : "",
    hasMore,
  };
}

function parseDescribeIds(request: Record<string, unknown>): string[] {
  const raw = request.ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > DESCRIBE_MAX_IDS) {
    throw invalidRequestError();
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string" || !DESCRIBE_ID.test(id)) {
      throw invalidRequestError();
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const describeItem = (
  id: string,
  kind: string,
  name: string,
): ConnectorSelectionDescribeItem => ({
  id,
  kind,
  name: truncate(name, NAME_MAX),
  detail: null,
  exists: true,
  meta: {},
});

/**
 * `ghost.describe`: kind-qualified ids to names, in request order, each id once.
 * The two content types are fixed labels; tags, posts and pages are read with
 * one `id` filter per kind (the id count is bounded by the contract at 100,
 * which is the page size of a list, so one request holds them all). An id the site does
 * not know (a tag or item that is gone, or an unpublished one) is omitted.
 */
export async function describeSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionDescribeResult> {
  const { client, request } = context;
  const ids = parseDescribeIds(request);
  const wanted: Record<"tag" | "post" | "page", string[]> = {
    tag: [],
    post: [],
    page: [],
  };
  for (const id of ids) {
    const match = DESCRIBE_ID.exec(id) as RegExpExecArray;
    const kind = match[2] as "tag" | "post" | "page" | undefined;
    if (kind !== undefined) wanted[kind].push(match[3] as string);
  }

  const names = new Map<string, string>();
  if (wanted.tag.length > 0) {
    for (const tag of await client.listTagsByIds(wanted.tag)) {
      names.set(`tag:${tag.id}`, tagName(tag));
    }
  }
  for (const type of ["post", "page"] as const) {
    if (wanted[type].length === 0) continue;
    const result = await client.listItems(routeOf(type), {
      page: 1,
      ids: wanted[type],
    });
    for (const item of result.items) {
      names.set(`${type}:${item.id}`, titleOf(item));
    }
  }

  const items: ConnectorSelectionDescribeItem[] = [];
  for (const id of ids) {
    if (id === "type:post") {
      items.push(describeItem(id, "type", "All posts"));
    } else if (id === "type:page") {
      items.push(describeItem(id, "type", "All pages"));
    } else {
      const name = names.get(id);
      if (name !== undefined) {
        items.push(describeItem(id, id.slice(0, id.indexOf(":")), name));
      }
    }
  }
  return { items };
}

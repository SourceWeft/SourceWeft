import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { invalidRequestError } from "./adapter-error";
import type { WordPressClient } from "./client";
import {
  WORDPRESS_CATEGORY_ID_PATTERN,
  WORDPRESS_ID_PATTERN,
} from "./contribution";
import { fetchSingleItem } from "./lookup";
import {
  titleOf,
  validateLink,
  type WpPost,
  type WpSearchHit,
  type WpTerm,
} from "./model";

/** The selection contract's own per-result bound on entries. */
const BROWSE_MAX_ENTRIES = 500;
/** The selection contract's own bound on breadcrumbs. */
const BROWSE_MAX_BREADCRUMBS = 50;
/** The contract's bound on an entry/container name. */
const NAME_MAX = 1024;
/** The search query bound (matches the contribution's `maxLength`). */
const QUERY_MAX = 200;
/** The cursor bound (matches the contribution's `maxLength`). */
const CURSOR_MAX = 4096;
/** The describe `ids` bound (matches the contribution's `maxItems`). */
const DESCRIBE_MAX_IDS = 100;
/** The client's own page ceiling; a cursor beyond it can never be valid. */
const MAX_PAGE = 100_000;

const ID = new RegExp(WORDPRESS_ID_PATTERN);
const CATEGORY_ID = new RegExp(WORDPRESS_CATEGORY_ID_PATTERN);

/** What every selection action receives: a fresh client, the request, the
 * validated site host (for untrusted search-hit links) and whether unpublished
 * content may be read (login connector only; always false for the public one). */
export type SelectionContext = {
  client: WordPressClient;
  request: Record<string, unknown>;
  siteHost: string;
  includeUnpublished: boolean;
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const typeEntry = (type: "post" | "page"): ConnectorSelectionEntry => ({
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

const categoryEntry = (
  category: WpTerm,
  hasChildren: boolean,
): ConnectorSelectionEntry => ({
  id: `category:${category.id}`,
  kind: "category",
  name: truncate(category.name, NAME_MAX),
  detail: null,
  selectable: true,
  expandable: hasChildren,
  disabledReason: null,
  size: null,
  modifiedAt: null,
});

/** The category list once, indexed by id (first of a duplicated id wins) and by
 * parent, so children and ancestors resolve without re-reading the site. */
type Tree = {
  byId: Map<number, WpTerm>;
  children: (id: number) => WpTerm[];
  hasChildren: (id: number) => boolean;
};

async function loadTree(client: WordPressClient): Promise<Tree> {
  const categories = await client.listCategories();
  const byId = new Map<number, WpTerm>();
  const children = new Map<number, WpTerm[]>();
  for (const category of categories) {
    if (!byId.has(category.id)) byId.set(category.id, category);
    const siblings = children.get(category.parent);
    if (siblings) siblings.push(category);
    else children.set(category.parent, [category]);
  }
  return {
    byId,
    children: (id) => children.get(id) ?? [],
    hasChildren: (id) => (children.get(id)?.length ?? 0) > 0,
  };
}

/** The ancestors strictly above `category`, outermost first; innermost 50.
 * Cycles terminate. */
function breadcrumbsFor(
  tree: Tree,
  category: WpTerm,
): Array<{ id: string; name: string }> {
  const chain: WpTerm[] = [];
  const seen = new Set<number>([category.id]);
  let parent =
    category.parent === 0 ? undefined : tree.byId.get(category.parent);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    chain.unshift(parent);
    parent = parent.parent === 0 ? undefined : tree.byId.get(parent.parent);
  }
  return chain.slice(-BROWSE_MAX_BREADCRUMBS).map((entry) => ({
    id: `category:${entry.id}`,
    name: truncate(entry.name, NAME_MAX),
  }));
}

function parseContainerId(request: Record<string, unknown>): number | null {
  const raw = request.containerId;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalidRequestError();
  const match = CATEGORY_ID.exec(raw);
  if (match === null) throw invalidRequestError();
  return Number(raw.slice("category:".length));
}

/** Browse issues no cursor of its own (a category's subcategories all fit in one
 * result), so any non-empty cursor is invalid. */
function rejectCursor(request: Record<string, unknown>): void {
  const cursor = request.cursor;
  if (cursor === undefined) return;
  if (typeof cursor !== "string" || cursor.length > CURSOR_MAX) {
    throw invalidRequestError();
  }
  if (cursor !== "") throw invalidRequestError();
}

/**
 * `<id>.browse`: at the root, the two content types ("All posts", "All pages")
 * then the top-level categories; inside a category container, that category's
 * subcategories with its ancestors as breadcrumbs. Posts and pages themselves
 * are not listed here (they are reached through search); a category that is not
 * in the site's list cannot be opened.
 */
export async function browseSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionBrowseResult> {
  const { client, request } = context;
  const containerId = parseContainerId(request);
  rejectCursor(request);
  const tree = await loadTree(client);

  if (containerId === null) {
    const entries: ConnectorSelectionEntry[] = [
      typeEntry("post"),
      typeEntry("page"),
      ...tree
        .children(0)
        .map((category) =>
          categoryEntry(category, tree.hasChildren(category.id)),
        ),
    ];
    return {
      container: null,
      breadcrumbs: [],
      entries: entries.slice(0, BROWSE_MAX_ENTRIES),
      cursor: "",
      hasMore: entries.length > BROWSE_MAX_ENTRIES,
      helpLink: null,
    };
  }

  const container = tree.byId.get(containerId);
  if (!container) throw invalidRequestError();
  const entries = tree
    .children(container.id)
    .map((category) => categoryEntry(category, tree.hasChildren(category.id)));
  return {
    container: {
      id: `category:${container.id}`,
      kind: "category",
      name: truncate(container.name, NAME_MAX),
      detail: null,
    },
    breadcrumbs: breadcrumbsFor(tree, container),
    entries: entries.slice(0, BROWSE_MAX_ENTRIES),
    cursor: "",
    hasMore: entries.length > BROWSE_MAX_ENTRIES,
    helpLink: null,
  };
}

function encodeCursor(page: number): string {
  return Buffer.from(JSON.stringify({ p: page }), "utf8").toString("base64url");
}

/** Strict inverse of {@link encodeCursor}: the 1-based page to read next. */
function decodeCursor(cursor: string): number {
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
  const page = record.p;
  if (
    Object.keys(record).length !== 1 ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MAX_PAGE
  ) {
    throw invalidRequestError();
  }
  return page;
}

function parseSearchPage(request: Record<string, unknown>): number {
  const cursor = request.cursor;
  if (cursor === undefined || cursor === "") return 1;
  if (typeof cursor !== "string" || cursor.length > CURSOR_MAX) {
    throw invalidRequestError();
  }
  return decodeCursor(cursor);
}

const searchEntry = (hit: WpSearchHit): ConnectorSelectionEntry => ({
  id: `${hit.type}:${hit.id}`,
  kind: hit.type,
  name: truncate(hit.title === "" ? "Untitled" : hit.title, NAME_MAX),
  detail: null,
  selectable: true,
  expandable: false,
  disabledReason: null,
  size: null,
  modifiedAt: null,
});

/**
 * `<id>.search`: one page of the site's title search over posts and pages, as
 * kind-qualified entries. Each hit's `url` is untrusted: it is run through
 * {@link validateLink}, and a hit whose link is not on the site host is dropped
 * from the result rather than failing the whole search. Paging is an opaque
 * cursor over the site's own `X-WP-TotalPages`.
 */
export async function searchSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionSearchResult> {
  const { client, request, siteHost } = context;
  const query = request.query;
  if (typeof query !== "string") throw invalidRequestError();
  const text = query.trim();
  if (text.length < 1 || text.length > QUERY_MAX) throw invalidRequestError();
  const page = parseSearchPage(request);

  const result = await client.searchContent(text, page);
  const entries: ConnectorSelectionEntry[] = [];
  const seen = new Set<string>();
  for (const hit of result.items) {
    if (entries.length >= BROWSE_MAX_ENTRIES) break;
    try {
      validateLink(hit.url, siteHost);
    } catch {
      // An untrusted hit that points at another host is dropped, never used.
      continue;
    }
    const id = `${hit.type}:${hit.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(searchEntry(hit));
  }
  const hasMore = page < result.totalPages && result.items.length > 0;
  return {
    entries,
    cursor: hasMore ? encodeCursor(page + 1) : "",
    hasMore,
  };
}

function parseDescribeIds(request: Record<string, unknown>): string[] {
  const raw = request.ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > DESCRIBE_MAX_IDS) {
    throw invalidRequestError();
  }
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !ID.test(id)) throw invalidRequestError();
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

/** A tombstone for a requested id that does not resolve, so the web presenter
 * can show a "removed" badge; `kind` is the id's own prefix, as Discourse does. */
const tombstone = (
  id: string,
  kind: string,
): ConnectorSelectionDescribeItem => ({
  id,
  kind,
  name: null,
  detail: null,
  exists: false,
  meta: {},
});

/**
 * `<id>.describe`: one item per requested kind-qualified id, in request order.
 * The two content types are fixed labels; a category is named from the site's
 * category list; a post or page is read by id (the login connector may read
 * unpublished ones). An id that does not resolve — an unknown category, a post
 * or page that is gone or that this connector may not read — comes back as a
 * tombstone (`exists: false`, `name: null`) so the platform can mark the
 * selection as removed, never dropped.
 */
export async function describeSelection(
  context: SelectionContext,
): Promise<ConnectorSelectionDescribeResult> {
  const { client, request, includeUnpublished } = context;
  const ids = parseDescribeIds(request);
  let categories: Map<number, WpTerm> | null = null;
  const posts = new Map<string, WpPost | null>();
  const items: ConnectorSelectionDescribeItem[] = [];

  for (const id of ids) {
    const separator = id.indexOf(":");
    const head = id.slice(0, separator);
    if (head === "type") {
      const type = id.slice(separator + 1);
      items.push(
        describeItem(id, "type", type === "post" ? "All posts" : "All pages"),
      );
      continue;
    }
    if (head === "category") {
      if (categories === null) categories = (await loadTree(client)).byId;
      const category = categories.get(Number(id.slice(separator + 1)));
      items.push(
        category
          ? describeItem(id, "category", category.name)
          : tombstone(id, "category"),
      );
      continue;
    }
    const route = head === "post" ? "posts" : "pages";
    const number = Number(id.slice(separator + 1));
    const key = `${route}:${number}`;
    let post = posts.get(key);
    if (post === undefined) {
      post = await fetchSingleItem(client, route, number, includeUnpublished);
      posts.set(key, post);
    }
    items.push(
      post ? describeItem(id, head, titleOf(post)) : tombstone(id, head),
    );
  }
  return { items };
}

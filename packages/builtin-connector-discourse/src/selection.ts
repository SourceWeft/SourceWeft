import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { invalidRequestError } from "./adapter-error";
import { isNotFound, type DiscourseClient } from "./client";
import { DISCOURSE_ID_PATTERN } from "./contribution";
import {
  buildCategoryTree,
  titleOf,
  type CategoryTree,
  type DiscourseCategory,
  type DiscourseTopicRow,
} from "./model";

/** Topics one browse page lists, as the forum's own page size. */
const BROWSE_TOPICS_PER_PAGE = 30;
/** Topics a search result holds. */
const SEARCH_MAX_RESULTS = 50;
/**
 * Subcategories one browse result lists (the platform's own bound is 500, and
 * topics share it). More than this many subcategories of one category are not
 * reachable through browse; that is rare and a platform cap.
 */
const BROWSE_MAX_SUBCATEGORIES = 450;
/** Entries one browse result holds (the selection contract's own bound). */
const BROWSE_MAX_ENTRIES = 500;
/** Ancestors one browse result holds (the selection contract's own bound). */
const BROWSE_MAX_BREADCRUMBS = 50;
const QUERY_MAX = 200;
const CURSOR_MAX = 4096;
const DESCRIBE_MAX_IDS = 100;
/** The client's own page ceiling; a cursor beyond it can never be valid. */
const MAX_PAGE = 100_000;
const NAME_MAX = 1024;
const DETAIL_MAX = 2048;

const ID = new RegExp(DISCOURSE_ID_PATTERN);
const CATEGORY_ID = /^category:([1-9][0-9]{0,9})$/;

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

type Forum = {
  byId: Map<number, DiscourseCategory>;
  tree: CategoryTree;
};

/** Reads the category list once; the first of a duplicated id wins, as in the tree. */
async function loadForum(client: DiscourseClient): Promise<Forum> {
  const { categories } = await client.site();
  const byId = new Map<number, DiscourseCategory>();
  for (const category of categories) {
    if (!byId.has(category.id)) byId.set(category.id, category);
  }
  return { byId, tree: buildCategoryTree(categories) };
}

/** A category that is listed and neither it nor an ancestor is read-restricted. */
function readable(forum: Forum, id: number | null): boolean {
  return id !== null && forum.byId.has(id) && !forum.tree.isRestricted(id);
}

/** A topic a viewer without an account may open, in a category that is readable. */
function visibleTopic(forum: Forum, row: DiscourseTopicRow): boolean {
  return row.visible && readable(forum, row.categoryId);
}

function topicDetail(row: DiscourseTopicRow): string {
  const posts = `${row.postsCount} ${row.postsCount === 1 ? "post" : "posts"}`;
  const date = row.lastPostedAt?.slice(0, 10);
  return date ? `${date} · ${posts}` : posts;
}

function topicEntry(row: DiscourseTopicRow): ConnectorSelectionEntry {
  return {
    id: `topic:${row.id}`,
    kind: "topic",
    name: truncate(titleOf(row), NAME_MAX),
    detail: truncate(topicDetail(row), DETAIL_MAX),
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: null,
    modifiedAt:
      row.lastPostedAt === null ? null : truncate(row.lastPostedAt, 64),
  };
}

function categoryEntry(
  forum: Forum,
  category: DiscourseCategory,
): ConnectorSelectionEntry {
  const open = !forum.tree.isRestricted(category.id);
  return {
    id: `category:${category.id}`,
    kind: "category",
    name: truncate(category.name, NAME_MAX),
    detail: null,
    selectable: open,
    // A restricted category cannot be opened, so it is no dead end.
    expandable:
      open &&
      (category.topicCount > 0 || forum.tree.children(category.id).length > 0),
    disabledReason: open ? null : "restricted",
    size: null,
    modifiedAt: null,
  };
}

/** The ancestors strictly above `category`, outermost first; innermost 50. */
function breadcrumbsFor(
  forum: Forum,
  category: DiscourseCategory,
): Array<{ id: string; name: string }> {
  const chain: DiscourseCategory[] = [];
  const seen = new Set<number>([category.id]);
  let parent =
    category.parentId === null ? undefined : forum.byId.get(category.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    chain.unshift(parent);
    parent =
      parent.parentId === null ? undefined : forum.byId.get(parent.parentId);
  }
  return chain.slice(-BROWSE_MAX_BREADCRUMBS).map((entry) => ({
    id: `category:${entry.id}`,
    name: truncate(entry.name, NAME_MAX),
  }));
}

function encodeCursor(page: number): string {
  return Buffer.from(JSON.stringify({ p: page }), "utf8").toString("base64url");
}

/** Strict inverse of {@link encodeCursor}: the page of topics to read next. */
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

/**
 * `discourse.browse`: the top-level categories of the forum, or the
 * subcategories (first page only) and topics of one category, 30 topics per
 * page with an opaque cursor. Restricted categories are listed but disabled.
 */
export async function browseForum(input: {
  client: DiscourseClient;
  request: Record<string, unknown>;
}): Promise<ConnectorSelectionBrowseResult> {
  const { client, request } = input;
  const { containerId, cursor } = request;
  let containerNumber: number | null = null;
  if (containerId !== undefined && containerId !== null) {
    const match =
      typeof containerId === "string" ? CATEGORY_ID.exec(containerId) : null;
    if (match === null) throw invalidRequestError();
    containerNumber = Number(match[1]);
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw invalidRequestError();
  }
  if (typeof cursor === "string" && cursor.length > CURSOR_MAX) {
    throw invalidRequestError();
  }
  const page = cursor === undefined || cursor === "" ? 0 : decodeCursor(cursor);

  const forum = await loadForum(input.client);

  if (containerNumber === null) {
    // The root has no pages to continue.
    if (page !== 0) throw invalidRequestError();
    return {
      container: null,
      breadcrumbs: [],
      // The platform caps a result at 500 entries; further top-level
      // categories are not reachable through browse (rare, a platform cap).
      entries: forum.tree
        .children(null)
        .slice(0, BROWSE_MAX_ENTRIES)
        .map((category) => categoryEntry(forum, category)),
      cursor: "",
      hasMore: false,
      helpLink: null,
    };
  }

  const container = forum.byId.get(containerNumber);
  if (!container || !readable(forum, container.id)) {
    throw invalidRequestError();
  }
  const listing = await client.categoryPage(container.id, page);
  // A category the forum refuses or no longer has cannot be browsed.
  if (isNotFound(listing)) throw invalidRequestError();

  const entries: ConnectorSelectionEntry[] =
    page === 0
      ? forum.tree
          .children(container.id)
          .slice(0, BROWSE_MAX_SUBCATEGORIES)
          .map((category) => categoryEntry(forum, category))
      : [];
  const seen = new Set<number>();
  for (const row of listing.topics) {
    if (seen.has(row.id) || !visibleTopic(forum, row)) continue;
    seen.add(row.id);
    entries.push(topicEntry(row));
  }
  // An empty page ends the walk even when the forum claims more.
  const hasMore = listing.hasMore && listing.topics.length > 0;
  return {
    container: {
      id: `category:${container.id}`,
      kind: "category",
      name: truncate(container.name, NAME_MAX),
      detail: null,
    },
    breadcrumbs: breadcrumbsFor(forum, container),
    entries: entries.slice(0, BROWSE_MAX_ENTRIES),
    cursor: hasMore ? encodeCursor(page + 1) : "",
    hasMore,
    helpLink: null,
  };
}

/**
 * `discourse.search`: the first page of the forum's own search, as topic
 * entries (at most 50, unique, visible, in readable categories).
 */
export async function searchForum(input: {
  client: DiscourseClient;
  request: Record<string, unknown>;
}): Promise<ConnectorSelectionSearchResult> {
  const { query, cursor } = input.request;
  if (typeof query !== "string") throw invalidRequestError();
  const text = query.trim();
  if (text.length < 1 || text.length > QUERY_MAX) throw invalidRequestError();
  if (cursor !== undefined) {
    // Search is one page; it never issues a cursor, so none can be valid.
    if (typeof cursor !== "string" || cursor.length > CURSOR_MAX) {
      throw invalidRequestError();
    }
    if (cursor !== "") throw invalidRequestError();
  }

  const forum = await loadForum(input.client);
  const result = await input.client.search(text, 1);
  const entries: ConnectorSelectionEntry[] = [];
  const seen = new Set<number>();
  for (const row of result.topics) {
    if (entries.length >= SEARCH_MAX_RESULTS) break;
    if (seen.has(row.id) || !visibleTopic(forum, row)) continue;
    seen.add(row.id);
    entries.push(topicEntry(row));
  }
  return { entries, cursor: "", hasMore: false };
}

/**
 * `discourse.describe`: for each requested kind-qualified id, in request
 * order, whether it exists and is readable, with its name and category path.
 * A duplicate id answers twice and is read once.
 */
export async function describeForum(input: {
  client: DiscourseClient;
  request: Record<string, unknown>;
}): Promise<ConnectorSelectionDescribeResult> {
  const { ids } = input.request;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > DESCRIBE_MAX_IDS ||
    !ids.every((id): id is string => typeof id === "string" && ID.test(id))
  ) {
    throw invalidRequestError();
  }

  const forum = await loadForum(input.client);
  const topics = new Map<number, ConnectorSelectionDescribeItem>();

  async function describeTopic(
    id: string,
    number: number,
  ): Promise<ConnectorSelectionDescribeItem> {
    const known = topics.get(number);
    if (known) return { ...known, id };
    const doc = await input.client.topic(number);
    const item: ConnectorSelectionDescribeItem =
      isNotFound(doc) || !visibleTopic(forum, doc)
        ? missing(id, "topic")
        : {
            id,
            kind: "topic",
            name: truncate(titleOf(doc), NAME_MAX),
            detail: truncate(
              forum.tree.pathOf(doc.categoryId as number),
              DETAIL_MAX,
            ),
            exists: true,
            meta: {},
          };
    topics.set(number, item);
    return item;
  }

  const items: ConnectorSelectionDescribeItem[] = [];
  // One topic at a time: each is a request through the client's own limits.
  for (const id of ids) {
    const separator = id.indexOf(":");
    const kind = id.slice(0, separator) as "category" | "topic";
    const number = Number(id.slice(separator + 1));
    if (kind === "topic") {
      items.push(await describeTopic(id, number));
      continue;
    }
    const category = forum.byId.get(number);
    items.push(
      category && readable(forum, number)
        ? {
            id,
            kind: "category",
            name: truncate(category.name, NAME_MAX),
            detail: truncate(forum.tree.pathOf(number), DETAIL_MAX),
            exists: true,
            meta: {},
          }
        : missing(id, "category"),
    );
  }
  return { items };
}

function missing(
  id: string,
  kind: "category" | "topic",
): ConnectorSelectionDescribeItem {
  return { id, kind, name: null, detail: null, exists: false, meta: {} };
}

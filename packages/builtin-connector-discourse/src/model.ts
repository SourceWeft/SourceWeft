import { createHash } from "node:crypto";
import type { ConnectorItem } from "@sourceweft/contracts";
import { DiscourseError } from "./errors";
import { safeSlug, topicUrl } from "./forum-url";
import { MAX_METADATA_AUTHORS, MAX_METADATA_POST_IDS } from "./limits";

/**
 * The typed shape of a forum's JSON answers and the parsers that turn the
 * untrusted documents into it. Parsers are strict about what identifies an
 * object (its id) and tolerant about optional fields; a document that does
 * not fit throws a fixed-message {@link DiscourseError}. Nothing in a
 * document is treated as a URL.
 */

export type DiscourseCategory = {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  readRestricted: boolean;
  topicCount: number;
};

export type DiscourseSite = { categories: DiscourseCategory[] };

export type DiscourseTopicRow = {
  id: number;
  title: string;
  slug: string;
  categoryId: number | null;
  tags: string[];
  postsCount: number;
  highestPostNumber: number;
  createdAt: string | null;
  lastPostedAt: string | null;
  bumpedAt: string | null;
  archetype: string | null;
  closed: boolean;
  archived: boolean;
  visible: boolean;
};

export type DiscoursePost = {
  id: number;
  postNumber: number;
  username: string | null;
  name: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  version: number;
  replyToPostNumber: number | null;
  /** HTML as the forum rendered it. Untrusted. */
  cooked: string;
  postType: number;
  hidden: boolean;
  deletedAt: string | null;
  userDeleted: boolean;
  topicId: number | null;
};

export type DiscourseTopic = DiscourseTopicRow & {
  /** The posts the topic document carries (the first ones). */
  posts: DiscoursePost[];
  /** Every post id of the topic, in order. */
  stream: number[];
};

export type DiscourseSearchPost = {
  id: number;
  topicId: number | null;
  postNumber: number | null;
  username: string | null;
  blurb: string;
};

export type DiscourseCategoryPage = {
  topics: DiscourseTopicRow[];
  hasMore: boolean;
};

export type DiscourseSearchResult = {
  topics: DiscourseTopicRow[];
  posts: DiscourseSearchPost[];
  hasMore: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function bad(): DiscourseError {
  return new DiscourseError("DISCOURSE_BAD_RESPONSE");
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad();
  return value;
}

export function parseCategory(raw: unknown): DiscourseCategory {
  if (!isRecord(raw) || !isId(raw.id)) throw bad();
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    slug: typeof raw.slug === "string" ? raw.slug : "",
    parentId: isId(raw.parent_category_id) ? raw.parent_category_id : null,
    readRestricted: raw.read_restricted === true,
    topicCount: isCount(raw.topic_count) ? raw.topic_count : 0,
  };
}

/** `site.json`: every Discourse answers `categories` (a list). */
export function parseSite(json: unknown): DiscourseSite {
  if (!isRecord(json) || !Array.isArray(json.categories)) {
    throw new DiscourseError("DISCOURSE_NOT_A_DISCOURSE_SITE");
  }
  return { categories: json.categories.map(parseCategory) };
}

/** Tags are plain strings, or objects with a `name`, depending on the Discourse version. */
function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") tags.push(entry);
    else if (isRecord(entry) && typeof entry.name === "string") {
      tags.push(entry.name);
    }
  }
  return tags;
}

export function parseTopicRow(raw: unknown): DiscourseTopicRow {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.title !== "string") {
    throw bad();
  }
  return {
    id: raw.id,
    title: raw.title,
    slug: typeof raw.slug === "string" ? raw.slug : "",
    categoryId: isId(raw.category_id) ? raw.category_id : null,
    tags: parseTags(raw.tags),
    postsCount: isCount(raw.posts_count) ? raw.posts_count : 0,
    highestPostNumber: isCount(raw.highest_post_number)
      ? raw.highest_post_number
      : 0,
    createdAt: optString(raw.created_at),
    lastPostedAt: optString(raw.last_posted_at),
    bumpedAt: optString(raw.bumped_at),
    archetype: optString(raw.archetype),
    closed: raw.closed === true,
    archived: raw.archived === true,
    // Absent means visible: only an explicit false hides a topic.
    visible: raw.visible !== false,
  };
}

export function parsePost(raw: unknown): DiscoursePost {
  if (!isRecord(raw) || !isId(raw.id) || !isId(raw.post_number)) throw bad();
  return {
    id: raw.id,
    postNumber: raw.post_number,
    username: optString(raw.username),
    name: optString(raw.name),
    createdAt: optString(raw.created_at),
    updatedAt: optString(raw.updated_at),
    version: isCount(raw.version) ? raw.version : 1,
    replyToPostNumber: isId(raw.reply_to_post_number)
      ? raw.reply_to_post_number
      : null,
    cooked: typeof raw.cooked === "string" ? raw.cooked : "",
    postType: isCount(raw.post_type) ? raw.post_type : 1,
    hidden: raw.hidden === true,
    deletedAt: optString(raw.deleted_at),
    userDeleted: raw.user_deleted === true,
    topicId: isId(raw.topic_id) ? raw.topic_id : null,
  };
}

function postStream(json: unknown): Record<string, unknown> {
  if (!isRecord(json) || !isRecord(json.post_stream)) throw bad();
  return json.post_stream;
}

/** `c/<id>.json`: the topic list; only the presence of `more_topics_url` is read. */
export function parseCategoryPage(json: unknown): DiscourseCategoryPage {
  const topicList = isRecord(json) ? json.topic_list : undefined;
  if (!isRecord(topicList)) throw bad();
  return {
    topics: list(topicList.topics).map(parseTopicRow),
    hasMore:
      typeof topicList.more_topics_url === "string" &&
      topicList.more_topics_url !== "",
  };
}

/** `t/<id>.json`: the document must be the topic that was asked for. */
export function parseTopic(json: unknown, expectedId: number): DiscourseTopic {
  const row = parseTopicRow(json);
  if (row.id !== expectedId) throw bad();
  const stream = postStream(json);
  if (!Array.isArray(stream.stream) || !stream.stream.every(isId)) {
    throw bad();
  }
  return {
    ...row,
    posts: list(stream.posts).map(parsePost),
    stream: stream.stream as number[],
  };
}

/** `t/<id>/posts.json`. */
export function parseTopicPosts(json: unknown): DiscoursePost[] {
  return list(postStream(json).posts).map(parsePost);
}

function parseSearchPost(raw: unknown): DiscourseSearchPost {
  if (!isRecord(raw) || !isId(raw.id)) throw bad();
  return {
    id: raw.id,
    topicId: isId(raw.topic_id) ? raw.topic_id : null,
    postNumber: isId(raw.post_number) ? raw.post_number : null,
    username: optString(raw.username),
    blurb: typeof raw.blurb === "string" ? raw.blurb : "",
  };
}

/** `search.json`: `topics` and `posts` are absent when nothing matched. */
export function parseSearch(json: unknown): DiscourseSearchResult {
  if (!isRecord(json)) throw bad();
  const grouped = json.grouped_search_result;
  return {
    topics: list(json.topics).map(parseTopicRow),
    posts: list(json.posts).map(parseSearchPost),
    hasMore: isRecord(grouped) && grouped.more_full_page_results === true,
  };
}

// ------------------------------------------------------------------ text

const TITLE_MAX = 1_000;
const FIELD_MAX = 2_000;
const TAGS_MAX = 100;

/** Truncates to `max` UTF-16 units without leaving half a surrogate pair. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** Collapses every run of whitespace, so a value can never start a new block. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A one-line, trimmed, length-capped string, or `null` when nothing is left. */
export function lineOf(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = oneLine(value);
  return flat === "" ? null : capText(flat, max);
}

/** The topic title as stored and rendered: one line, capped, never empty. */
export function titleOf(row: DiscourseTopicRow): string {
  return lineOf(row.title, TITLE_MAX) ?? "Untitled topic";
}

/**
 * The tags as stored in metadata and hashed: one line each, empty ones
 * dropped, each capped, at most {@link TAGS_MAX}. The hash and the metadata
 * must see exactly the same list.
 */
export function tagsOf(row: DiscourseTopicRow): string[] {
  const tags: string[] = [];
  for (const tag of row.tags) {
    if (tags.length >= TAGS_MAX) break;
    const clean = lineOf(tag, FIELD_MAX);
    if (clean !== null) tags.push(clean);
  }
  return tags;
}

// ------------------------------------------------------------ categories

export type CategoryTree = {
  /** The selected ids plus all their descendants. Unknown ids are ignored. */
  expand(selectedIds: number[]): Set<number>;
  /** Names from the root joined by ` / `; `""` for an unknown id. */
  pathOf(id: number): string;
  /** Direct children of `parentId` (`null` = top level), sorted by name. */
  children(parentId: number | null): DiscourseCategory[];
  /** True when the category or any of its ancestors is read-restricted. */
  isRestricted(id: number): boolean;
};

export function buildCategoryTree(
  categories: DiscourseCategory[],
): CategoryTree {
  const byId = new Map<number, DiscourseCategory>();
  for (const category of categories) {
    if (!byId.has(category.id)) byId.set(category.id, category);
  }
  // A category whose parent is not listed is shown at the top level.
  const parentOf = (category: DiscourseCategory): number | null =>
    category.parentId !== null && byId.has(category.parentId)
      ? category.parentId
      : null;
  const byParent = new Map<number | null, DiscourseCategory[]>();
  for (const category of byId.values()) {
    const siblings = byParent.get(parentOf(category)) ?? [];
    siblings.push(category);
    byParent.set(parentOf(category), siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => {
      const left = a.name.toLowerCase();
      const right = b.name.toLowerCase();
      if (left !== right) return left < right ? -1 : 1;
      return a.id - b.id;
    });
  }

  /** The category, then its ancestors, stopping at a cycle. */
  const lineage = (id: number): DiscourseCategory[] => {
    const chain: DiscourseCategory[] = [];
    const seen = new Set<number>();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return chain;
  };

  return {
    expand(selectedIds) {
      const result = new Set<number>();
      const queue = selectedIds.filter((id) => byId.has(id));
      while (queue.length > 0) {
        const id = queue.pop() as number;
        if (result.has(id)) continue;
        result.add(id);
        for (const child of byParent.get(id) ?? []) queue.push(child.id);
      }
      return result;
    },
    pathOf(id) {
      return lineage(id)
        .map((category) => category.name)
        .reverse()
        .join(" / ");
    },
    children(parentId) {
      return [...(byParent.get(parentId) ?? [])];
    },
    isRestricted(id) {
      return lineage(id).some((category) => category.readRestricted);
    },
  };
}

// ----------------------------------------------------------------- posts

/**
 * A reader-visible post: a regular post (type 1), not hidden by flags and not
 * deleted. Whispers, moderator actions and small actions are never indexed.
 */
export function isVisiblePost(post: DiscoursePost): boolean {
  return (
    post.postType === 1 &&
    !post.hidden &&
    post.deletedAt === null &&
    !post.userDeleted
  );
}

// ---------------------------------------------------------------- hashes

/** How much of a topic a scan reads; part of every hash. */
export type RefreshMode = "light" | "deep";

function sha256(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function topicParts(row: DiscourseTopicRow, mode: RefreshMode): unknown[] {
  return [
    "discourse-topic",
    mode,
    row.id,
    titleOf(row),
    row.categoryId,
    [...tagsOf(row)].sort(),
    row.closed,
    row.archived,
    row.postsCount,
    row.highestPostNumber,
    row.lastPostedAt,
  ];
}

/**
 * Hex sha256 over the canonical form of the listing fields: id, title,
 * category, sorted tags, closed, archived, post counts and the last post
 * time. `bumpedAt` is deliberately not part of it.
 */
export function lightHashOf(row: DiscourseTopicRow): string {
  return sha256(topicParts(row, "light"));
}

/**
 * The light hash's fields plus `id:version:updated_at` of every visible post
 * in `posts`, sorted by post id so the order of `posts` does not matter. Pass
 * exactly the posts that are indexed.
 */
export function deepHashOf(
  row: DiscourseTopicRow,
  posts: DiscoursePost[],
): string {
  const entries = posts
    .filter(isVisiblePost)
    .sort((a, b) => a.id - b.id)
    .map((post) => `${post.id}:${post.version}:${post.updatedAt ?? ""}`);
  return sha256([...topicParts(row, "deep"), entries]);
}

// ------------------------------------------------------------ item build

export type ToConnectorItemInput = {
  /** A validated forum base (see `parseForumUrl`). */
  base: string;
  categoryPath: string;
  /**
   * The refresh mode `hash` was computed for. The mode is already part of the
   * hash input, so it is not stored separately.
   */
  refresh: RefreshMode;
  /** {@link lightHashOf} or {@link deepHashOf}. */
  hash: string;
  postIds: number[];
  authors: string[];
  /**
   * Posts of the topic that were not read (a topic longer than the per-topic
   * cap); recorded in the metadata only when greater than zero.
   */
  omittedPosts?: number;
};

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export function toConnectorItem(
  row: DiscourseTopicRow,
  input: ToConnectorItemInput,
): ConnectorItem {
  const metadata: Record<string, unknown> = {
    topicId: row.id,
    slug: safeSlug(row.slug),
  };
  if (row.categoryId !== null) metadata.categoryId = row.categoryId;
  const categoryPath = lineOf(input.categoryPath, FIELD_MAX);
  if (categoryPath !== null) metadata.categoryPath = categoryPath;
  const tags = tagsOf(row);
  if (tags.length > 0) metadata.tags = tags;
  metadata.postsCount = row.postsCount;
  const lastPostedAt = lineOf(row.lastPostedAt, FIELD_MAX);
  if (lastPostedAt !== null) metadata.lastPostedAt = lastPostedAt;
  metadata.closed = row.closed;
  metadata.archived = row.archived;
  const postIds = input.postIds.filter(isId).slice(0, MAX_METADATA_POST_IDS);
  if (postIds.length > 0) metadata.postIds = postIds;
  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const author of input.authors) {
    if (authors.length >= MAX_METADATA_AUTHORS) break;
    const clean = lineOf(author, FIELD_MAX);
    if (clean === null || seenAuthors.has(clean)) continue;
    seenAuthors.add(clean);
    authors.push(clean);
  }
  if (authors.length > 0) metadata.authors = authors;
  const createdAt = lineOf(row.createdAt, FIELD_MAX);
  if (createdAt !== null) metadata.createdAt = createdAt;
  if (
    input.omittedPosts !== undefined &&
    isId(input.omittedPosts) // a positive safe integer
  ) {
    metadata.omittedPosts = input.omittedPosts;
  }

  return {
    externalId: `discourse:topic:${row.id}`,
    externalUri: topicUrl(input.base, row.slug, row.id),
    title: titleOf(row),
    mimeType: "text/markdown",
    sizeBytes: null,
    externalUpdatedAt: parseDate(row.lastPostedAt ?? row.createdAt),
    contentHash: input.hash,
    metadata,
  };
}

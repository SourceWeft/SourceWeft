import { DiscourseError } from "./errors";

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

import { DiscourseError, type DiscourseErrorCode } from "./errors";
import { parseForumUrl } from "./forum-url";
import {
  DISCOURSE_USER_AGENT,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  POST_BATCH,
  REQUEST_TIMEOUT_MS,
} from "./limits";

/** Limits a test may lower; production uses the constants in `limits.ts`. */
export type ClientLimits = {
  maxRequests: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  minRequestGapMs: number;
};

export type CreateDiscourseClientInput = {
  /** A `fetch` from the host's public scope: it owns the address policy. */
  fetch: typeof fetch;
  /** A base returned by `parseForumUrl`. */
  base: string;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  limits?: Partial<ClientLimits>;
};

/** The forum has no such topic or category (404), or it was deleted (410). */
export class DiscourseNotFound {
  readonly kind = "not_found" as const;
}

export function isNotFound(value: unknown): value is DiscourseNotFound {
  return value instanceof DiscourseNotFound;
}

export type DiscourseCategory = {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  readRestricted: boolean;
  topicCount: number;
};

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

export type DiscourseClient = {
  /** One allow-listed GET; the 404/410 of a topic or category is {@link DiscourseNotFound}. */
  getJson(
    path: string,
    query?: Record<string, string | number | string[]>,
  ): Promise<unknown>;
  site(): Promise<{ categories: DiscourseCategory[] }>;
  /** `page` is 0-based, as the forum counts it. */
  categoryPage(
    categoryId: number,
    page: number,
  ): Promise<
    { topics: DiscourseTopicRow[]; hasMore: boolean } | DiscourseNotFound
  >;
  topic(topicId: number): Promise<DiscourseTopic | DiscourseNotFound>;
  topicPosts(
    topicId: number,
    postIds: number[],
  ): Promise<DiscoursePost[] | DiscourseNotFound>;
  /** `page` is 1-based, as the forum counts it. */
  search(
    query: string,
    page: number,
  ): Promise<{
    topics: DiscourseTopicRow[];
    posts: DiscourseSearchPost[];
    hasMore: boolean;
  }>;
};

const ID = "[1-9][0-9]{0,9}";
const SITE_PATH = /^site\.json$/;
const SEARCH_PATH = /^search\.json$/;
const ALLOWED_PATHS = [
  SITE_PATH,
  SEARCH_PATH,
  new RegExp(`^c/${ID}\\.json$`),
  new RegExp(`^t/${ID}\\.json$`),
  new RegExp(`^t/${ID}/posts\\.json$`),
];
const NOT_FOUND_PATHS = ALLOWED_PATHS.slice(2);
const QUERY_KEYS = new Set(["page", "q", "post_ids[]"]);
const MAX_PAGE = 100_000;
const MAX_QUERY_CHARS = 500;
/** A 429 body is only read for `extras.wait_seconds`; this is plenty. */
const MAX_RATE_LIMIT_BODY_BYTES = 65_536;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** The host's policy error is duck-typed: this package cannot import backend code. */
function isEndpointNotAllowed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED")
    return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED"
  );
}

class Timeout {}

/** Rejects when the signal aborts, so a fetch or read that ignores it cannot hang. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Timeout());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Timeout());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failed cancel changes nothing.
  }
}

/**
 * Reads at most `maxBytes` bytes and cancels the stream the moment one more
 * arrives, so a hostile body is never fully read.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const tooLarge = () => new DiscourseError("DISCOURSE_TOO_LARGE");
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    if (Number(declared.trim()) > maxBytes) {
      await discard(response);
      throw tooLarge();
    }
  }
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Already failing; the original error is what matters.
    }
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Throws unless `value` is a positive safe integer of at most ten digits. */
function requireId(value: unknown): number {
  if (!isId(value) || value > 9_999_999_999) {
    throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
  }
  return value;
}

function requirePage(value: unknown, min: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > MAX_PAGE
  ) {
    throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
  }
  return value;
}

function bad(): DiscourseError {
  return new DiscourseError("DISCOURSE_BAD_RESPONSE");
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseCategory(raw: unknown): DiscourseCategory {
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

function parseTopicRow(raw: unknown): DiscourseTopicRow {
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

function parsePost(raw: unknown): DiscoursePost {
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

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad();
  return value;
}

function postStream(json: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(json.post_stream)) throw bad();
  return json.post_stream;
}

/**
 * A read-only client for a public Discourse forum's JSON API. Only five
 * fixed GET endpoints can be requested, every URL is built here from the
 * validated base and validated ids: nothing in a response (not even
 * `more_topics_url`) is ever followed. The `fetch` is the host's public-scope
 * fetch, which owns the address policy. Every failure is a
 * {@link DiscourseError} with a fixed message: nothing from the forum, the URL
 * or an underlying error is forwarded.
 */
export function createDiscourseClient(
  input: CreateDiscourseClientInput,
): DiscourseClient {
  const parsedBase = parseForumUrl(input.base);
  if (parsedBase === null || parsedBase.base !== input.base) {
    throw new DiscourseError("DISCOURSE_FORUM_URL_INVALID");
  }
  const base = parsedBase.base;
  const limits: ClientLimits = {
    maxRequests: MAX_REQUESTS,
    maxRetries: MAX_RETRIES,
    maxRetryDelayMs: MAX_RETRY_DELAY_MS,
    minRequestGapMs: MIN_REQUEST_GAP_MS,
    ...input.limits,
  };
  const now = input.now ?? Date.now;
  const external = input.signal;
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  /** Waits `ms`; the default wait ends early when the scan's signal aborts. */
  function wait(ms: number): Promise<void> {
    if (input.sleep) return input.sleep(ms);
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        external?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      external?.addEventListener("abort", onAbort, { once: true });
    });
  }

  let requestCount = 0;
  let lastRequestAt: number | null = null;

  function buildUrl(
    path: string,
    query: Record<string, string | number | string[]> | undefined,
  ): string {
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
      throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!QUERY_KEYS.has(key)) {
        throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
      }
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (typeof entry === "number") {
          if (!Number.isSafeInteger(entry) || entry < 0) {
            throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
          }
          params.append(key, String(entry));
        } else if (typeof entry === "string") {
          params.append(key, entry);
        } else {
          throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
        }
      }
    }
    const qs = params.toString();
    return `${base}/${path}${qs === "" ? "" : `?${qs}`}`;
  }

  /** Seconds the forum asked us to wait: header first, then the JSON body. */
  async function rateLimitWaitMs(
    response: Response,
    attempt: number,
    signal: AbortSignal,
  ): Promise<number> {
    const fallback = 1000 * (attempt + 1);
    const cap = (ms: number) => Math.min(ms, limits.maxRetryDelayMs);
    const header = response.headers.get("retry-after")?.trim();
    if (header !== undefined && /^\d{1,9}$/.test(header)) {
      await discard(response);
      return cap(Number(header) * 1000);
    }
    try {
      const bytes = await readCapped(
        response,
        Math.min(maxBytes, MAX_RATE_LIMIT_BODY_BYTES),
        signal,
      );
      const body: unknown = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      const extras = isRecord(body) ? body.extras : undefined;
      const seconds = isRecord(extras) ? extras.wait_seconds : undefined;
      if (
        typeof seconds === "number" &&
        Number.isFinite(seconds) &&
        seconds >= 0
      ) {
        return cap(Math.ceil(seconds) * 1000);
      }
    } catch {
      // No usable hint: the bounded fallback applies.
    }
    return cap(fallback);
  }

  async function perform(
    path: string,
    query: Record<string, string | number | string[]> | undefined,
    nonJson: DiscourseErrorCode,
  ): Promise<unknown> {
    const url = buildUrl(path, query);
    const missing = NOT_FOUND_PATHS.some((pattern) => pattern.test(path));
    const isSite = SITE_PATH.test(path);

    for (let attempt = 0; ; attempt += 1) {
      if (external?.aborted) {
        throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
      }
      // Checked before anything is sent, so the ceiling is never exceeded.
      if (requestCount >= limits.maxRequests) {
        throw new DiscourseError("DISCOURSE_TOO_LARGE");
      }
      requestCount += 1;
      if (lastRequestAt !== null) {
        const elapsed = now() - lastRequestAt;
        if (elapsed < limits.minRequestGapMs) {
          await wait(limits.minRequestGapMs - elapsed);
          if (external?.aborted) {
            throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
          }
        }
      }
      lastRequestAt = now();

      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Timeout()),
        timeoutMs,
      );
      const onExternalAbort = () => controller.abort(new Timeout());
      external?.addEventListener("abort", onExternalAbort, { once: true });

      let waitMs = Math.min(500 * (attempt + 1), limits.maxRetryDelayMs);
      let finalFailure: DiscourseErrorCode = "DISCOURSE_FORUM_UNREACHABLE";
      try {
        const response = await abortable(
          input.fetch(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              "User-Agent": DISCOURSE_USER_AGENT,
            },
            signal,
          }),
          signal,
        );
        const { status } = response;
        if (status === 200) {
          const bytes = await readCapped(response, maxBytes, signal);
          let json: unknown;
          try {
            json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
          } catch {
            throw new DiscourseError(nonJson);
          }
          if (!isRecord(json)) throw bad();
          return json;
        }
        if (RETRY_STATUSES.has(status)) {
          if (status === 429) {
            finalFailure = "DISCOURSE_RATE_LIMITED";
            waitMs = await rateLimitWaitMs(response, attempt, signal);
          } else {
            await discard(response);
          }
          if (attempt >= limits.maxRetries)
            throw new DiscourseError(finalFailure);
          // Falls out of the try: the timer is cleared before the wait.
        } else {
          await discard(response);
          if (status === 403)
            throw new DiscourseError("DISCOURSE_LOGIN_REQUIRED");
          if (status === 404 && isSite) {
            throw new DiscourseError("DISCOURSE_NOT_A_DISCOURSE_SITE");
          }
          if ((status === 404 || status === 410) && missing) {
            return new DiscourseNotFound();
          }
          if (status >= 400) {
            throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
          }
          // A redirect or another success code: never followed, never trusted.
          throw bad();
        }
      } catch (error) {
        if (error instanceof DiscourseError) throw error;
        if (isEndpointNotAllowed(error)) {
          throw new DiscourseError("DISCOURSE_BLOCKED_ENDPOINT");
        }
        if (error instanceof Timeout || signal.aborted) {
          throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
        }
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") {
          throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
        }
        if (attempt >= limits.maxRetries) {
          throw new DiscourseError("DISCOURSE_FORUM_UNREACHABLE");
        }
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      }
      await wait(waitMs);
    }
  }

  function getJson(
    path: string,
    query?: Record<string, string | number | string[]>,
  ): Promise<unknown> {
    return perform(path, query, "DISCOURSE_BAD_RESPONSE");
  }

  return {
    getJson,

    async site() {
      const json = (await perform(
        "site.json",
        undefined,
        "DISCOURSE_NOT_A_DISCOURSE_SITE",
      )) as Record<string, unknown>;
      // Every Discourse answers `categories` (a list) on `site.json`.
      if (!Array.isArray(json.categories)) {
        throw new DiscourseError("DISCOURSE_NOT_A_DISCOURSE_SITE");
      }
      return { categories: json.categories.map(parseCategory) };
    },

    async categoryPage(categoryId, page) {
      const id = requireId(categoryId);
      const json = await getJson(`c/${id}.json`, {
        page: requirePage(page, 0),
      });
      if (isNotFound(json)) return json;
      const topicList = (json as Record<string, unknown>).topic_list;
      if (!isRecord(topicList)) throw bad();
      return {
        topics: list(topicList.topics).map(parseTopicRow),
        // Only presence matters: the value is a path we never follow.
        hasMore:
          typeof topicList.more_topics_url === "string" &&
          topicList.more_topics_url !== "",
      };
    },

    async topic(topicId) {
      const id = requireId(topicId);
      const json = await getJson(`t/${id}.json`);
      if (isNotFound(json)) return json;
      const document = json as Record<string, unknown>;
      const row = parseTopicRow(document);
      if (row.id !== id) throw bad();
      const stream = postStream(document);
      if (!Array.isArray(stream.stream) || !stream.stream.every(isId)) {
        throw bad();
      }
      return {
        ...row,
        posts: list(stream.posts).map(parsePost),
        stream: stream.stream as number[],
      };
    },

    async topicPosts(topicId, postIds) {
      const id = requireId(topicId);
      if (
        !Array.isArray(postIds) ||
        postIds.length === 0 ||
        postIds.length > POST_BATCH
      ) {
        throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
      }
      const ids = postIds.map((postId) => String(requireId(postId)));
      const json = await getJson(`t/${id}/posts.json`, { "post_ids[]": ids });
      if (isNotFound(json)) return json;
      return list(postStream(json as Record<string, unknown>).posts).map(
        parsePost,
      );
    },

    async search(query, page) {
      if (
        typeof query !== "string" ||
        query.trim() === "" ||
        query.length > MAX_QUERY_CHARS
      ) {
        throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
      }
      const json = (await getJson("search.json", {
        q: query,
        page: requirePage(page, 1),
      })) as Record<string, unknown>;
      const grouped = json.grouped_search_result;
      return {
        topics: list(json.topics).map(parseTopicRow),
        posts: list(json.posts).map((raw): DiscourseSearchPost => {
          if (!isRecord(raw) || !isId(raw.id)) throw bad();
          return {
            id: raw.id,
            topicId: isId(raw.topic_id) ? raw.topic_id : null,
            postNumber: isId(raw.post_number) ? raw.post_number : null,
            username: optString(raw.username),
            blurb: typeof raw.blurb === "string" ? raw.blurb : "",
          };
        }),
        hasMore: isRecord(grouped) && grouped.more_full_page_results === true,
      };
    },
  };
}

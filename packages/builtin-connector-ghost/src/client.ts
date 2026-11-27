import { GhostError } from "./errors";
import {
  GHOST_USER_AGENT,
  ID_BATCH,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
} from "./limits";
import {
  oneLine,
  parseItem,
  parseListItem,
  parsePagination,
  parseTag,
  type GhostContentType,
  type GhostItem,
  type GhostListItem,
  type GhostTag,
} from "./model";
import { parseSiteUrl } from "./site-url";

/** Limits a test may lower; production uses the constants in `limits.ts`. */
export type ClientLimits = {
  maxRequests: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  minRequestGapMs: number;
};

/** One read: the parsed JSON body of a 200 answer. */
export type GhostJson = { body: unknown };

/** The route (a post, page…) does not exist (404); the caller decides whether
 * that is a gone item or a bad listing. */
export class GhostNotFound {
  readonly kind = "not_found" as const;
}

export function isNotFound(value: unknown): value is GhostNotFound {
  return value instanceof GhostNotFound;
}

/** The two listable content routes. */
export type GhostItemRoute = "posts" | "pages";

/** What a list call may narrow by. At most one of `tagIds` and `ids`, and at
 * most {@link ID_BATCH} of them: more is a programming error, the caller
 * batches. */
export type ListItemsParams = {
  page: number;
  tagIds?: string[];
  ids?: string[];
};

export type ListItemsResult = {
  items: GhostListItem[];
  total: number;
  pages: number;
};

export type GhostClient = {
  /**
   * A GET of a Content API route such as `posts`, `posts/<id>`, `settings` or
   * `tags`. The URL is `<siteBase>/ghost/api/content/<route>/?<params>&key=<key>`
   * (trailing slash before the query, key last). A 404 on a route other than
   * `settings` is {@link GhostNotFound}.
   */
  getJson(
    route: string,
    params?: Record<string, string | number>,
  ): Promise<GhostJson | GhostNotFound>;
  /**
   * One page (100 items, `order=id asc`) of the published posts or pages with
   * the fixed `fields` and their tags. A 404 on a list route is a bad answer
   * (`BAD_RESPONSE`), never an empty list.
   */
  listItems(
    route: GhostItemRoute,
    params: ListItemsParams,
  ): Promise<ListItemsResult>;
  /** One post or page with its html, tags and authors, or `null` when the
   * site has no such item (404). Any other failure throws. */
  getItem(route: GhostItemRoute, id: string): Promise<GhostItem | null>;
  /** One page (100) of the site's tags. */
  listTags(page: number): Promise<{ tags: GhostTag[]; pages: number }>;
  /** The tags with these ids (1 to {@link ID_BATCH}); unknown ids are absent. */
  listTagsByIds(ids: string[]): Promise<GhostTag[]>;
  /** The readiness read: `settings` must be a Ghost settings object. */
  getSettings(): Promise<{ title: string | null }>;
  /** One page of posts or pages whose title contains `query`. */
  searchContent(
    query: string,
    route: GhostItemRoute,
    page: number,
  ): Promise<ListItemsResult>;
  /** Requests this client has issued, retries included. */
  requestCount(): number;
};

export type CreateGhostClientInput = {
  /** The host fetch scope: it owns the address policy. */
  fetch: typeof fetch;
  /** A site base as `parseSiteUrl` returns it (re-validated here). */
  siteBase: string;
  /** The Content API key; placed only in the query string of site requests. */
  key: string;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  limits?: Partial<ClientLimits>;
};

/** Fixed `fields` of a listing: nothing else of an item is read from a list. */
const LIST_FIELDS =
  "id,slug,url,title,updated_at,published_at,visibility,access,canonical_url";
/** Longest title query accepted by {@link GhostClient.searchContent}. */
const MAX_QUERY_LENGTH = 200;
const ID_FORMAT = /^[0-9a-f]{24}$/;

/** `posts`, `settings`, or `posts/<24 hex id>`: nothing else is ever requested. */
const ROUTE = /^[a-z]+(?:\/[0-9a-f]{24})?$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Longest key accepted; real keys are 26 characters. */
const MAX_KEY_LENGTH = 256;
/** Error bodies are read only for a Ghost error `code`; this is plenty. */
const ERROR_BODY_BYTES = 65_536;

class Timeout {}

/**
 * The host's endpoint policy refused a request or a redirect target (a
 * cross-origin `Location`, a non-https or non-public one). The host throws its
 * own `EndpointPolicyError` instead of returning the 3xx response, so the
 * 3xx check below never sees it. A connector package cannot import backend
 * code: the error is recognised by its stable `code`, directly or on `cause`,
 * as the other connectors do.
 */
function isEndpointNotAllowed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED"
  );
}

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
 * arrives, so a hostile body is never fully read. Over the cap is TOO_LARGE
 * for a `throw` read, or a silently shortened body for a `truncate` read.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onOverflow: "throw" | "truncate",
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    onOverflow === "throw" &&
    declared !== null &&
    /^\d+$/.test(declared.trim()) &&
    Number(declared.trim()) > maxBytes
  ) {
    await discard(response);
    throw new GhostError("TOO_LARGE");
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
      if (total + value.byteLength > maxBytes) {
        if (onOverflow === "throw") throw new GhostError("TOO_LARGE");
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        await reader.cancel();
        break;
      }
      total += value.byteLength;
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

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Whether an error body is Ghost's `UNKNOWN_CONTENT_API_KEY`. Nothing else of
 * the body is ever kept. */
function isUnknownKey(bytes: Uint8Array): boolean {
  let body: unknown;
  try {
    body = JSON.parse(decode(bytes));
  } catch {
    return false;
  }
  if (!isRecord(body) || !Array.isArray(body.errors)) return false;
  return body.errors.some(
    (entry) => isRecord(entry) && entry.code === "UNKNOWN_CONTENT_API_KEY",
  );
}

/** Milliseconds to wait before a retry: a `Retry-After` header (seconds or an
 * HTTP date) wins, capped; otherwise a bounded backoff. */
function retryAfterMs(
  response: Response,
  attempt: number,
  now: () => number,
  maxDelay: number,
): number {
  const backoff = Math.min(500 * (attempt + 1), maxDelay);
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return backoff;
  if (/^\d{1,9}$/.test(header)) {
    return Math.min(Number(header) * 1000, maxDelay);
  }
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now()), maxDelay);
  return backoff;
}

function buildUrl(
  siteBase: string,
  key: string,
  route: string,
  params: Record<string, string | number> | undefined,
): string {
  if (!ROUTE.test(route)) throw new GhostError("CONFIG_INVALID");
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params ?? {})) {
    // `key` is ours alone: a caller cannot set, repeat or shadow it.
    if (!PARAM_NAME.test(name) || name === "key") {
      throw new GhostError("CONFIG_INVALID");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new GhostError("CONFIG_INVALID");
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new GhostError("CONFIG_INVALID");
    }
    parts.push(`${name}=${encodeURIComponent(String(value))}`);
  }
  // The key is last, and the route always ends in a slash: Ghost answers the
  // no-slash form with a 301 that would carry the key to wherever it points.
  parts.push(`key=${encodeURIComponent(key)}`);
  return `${siteBase}/ghost/api/content/${route}/?${parts.join("&")}`;
}

type RawResponse = { status: number; bytes: Uint8Array };

/**
 * A read-only client for a Ghost site's Content API. Every URL is built from
 * the validated site base, a fixed route shape and the key, and nothing in a
 * response body is ever requested, so the key goes only to the site's own
 * origin. It is never sent in a header (Ghost refuses that) and no redirect is
 * followed: a 3xx is `BLOCKED_ENDPOINT`. Every failure is a {@link GhostError}
 * with a fixed message: the site address, the key and the body are never
 * forwarded, no `cause` is set and nothing is logged.
 */
export function createGhostClient(input: CreateGhostClientInput): GhostClient {
  const siteBase = parseSiteUrl(input.siteBase);
  const maxBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const now = input.now ?? Date.now;
  const external = input.signal;
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const limits: ClientLimits = {
    maxRequests: MAX_REQUESTS,
    maxRetries: MAX_RETRIES,
    maxRetryDelayMs: MAX_RETRY_DELAY_MS,
    minRequestGapMs: MIN_REQUEST_GAP_MS,
    ...input.limits,
  };
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Version": "v5.0",
    "User-Agent": GHOST_USER_AGENT,
  };

  let requestCount = 0;
  let lastRequestAt: number | null = null;

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

  /** Reads the final 200/4xx/5xx body (capped) and hands the status back. */
  async function handle(
    response: Response,
    signal: AbortSignal,
  ): Promise<RawResponse> {
    const { status } = response;
    if (status === 200) {
      return {
        status,
        bytes: await readCapped(response, maxBytes, signal, "throw"),
      };
    }
    if (status === 403) {
      return {
        status,
        bytes: await readCapped(
          response,
          Math.min(maxBytes, ERROR_BODY_BYTES),
          signal,
          "truncate",
        ),
      };
    }
    await discard(response);
    return { status, bytes: new Uint8Array(0) };
  }

  /** One logical GET. It owns the budget, the gap, the retries and the
   * 3xx/429/network outcomes; the final response is read by {@link handle}. */
  async function perform(url: string): Promise<RawResponse> {
    let attempt = 0;
    for (;;) {
      if (external?.aborted) throw new GhostError("SITE_UNREACHABLE");
      // Checked before anything is sent, so the ceiling is never exceeded.
      if (requestCount >= limits.maxRequests) throw new GhostError("TOO_LARGE");
      requestCount += 1;
      if (lastRequestAt !== null) {
        const elapsed = now() - lastRequestAt;
        if (elapsed < limits.minRequestGapMs) {
          await wait(limits.minRequestGapMs - elapsed);
          if (external?.aborted) throw new GhostError("SITE_UNREACHABLE");
        }
      }

      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Timeout()),
        timeoutMs,
      );
      const onExternalAbort = () => controller.abort(new Timeout());
      external?.addEventListener("abort", onExternalAbort, { once: true });

      let retry = false;
      let waitMs = Math.min(500 * (attempt + 1), limits.maxRetryDelayMs);
      try {
        const response = await abortable(
          input.fetch(url, {
            method: "GET",
            headers,
            // The host scope follows a cross-origin redirect unless told not
            // to. `manual` hands any 3xx back, which is refused below: the key
            // never follows a redirect and no endpoint is reached indirectly.
            redirect: "manual",
            signal,
          }),
          signal,
        );
        const { status } = response;
        if (status >= 300 && status < 400) {
          await discard(response);
          throw new GhostError("BLOCKED_ENDPOINT");
        }
        const retryable = status === 429 || (status >= 500 && status <= 599);
        if (retryable && attempt < limits.maxRetries) {
          if (status === 429) {
            waitMs = retryAfterMs(
              response,
              attempt,
              now,
              limits.maxRetryDelayMs,
            );
          }
          await discard(response);
          retry = true;
        } else if (status === 429) {
          await discard(response);
          throw new GhostError("RATE_LIMITED");
        } else {
          return await handle(response, signal);
        }
      } catch (error) {
        if (error instanceof GhostError) throw error;
        // A refusal is a decision, never retried. Nothing of the host's error
        // (its message, its target) is kept.
        if (isEndpointNotAllowed(error)) {
          throw new GhostError("BLOCKED_ENDPOINT");
        }
        if (external?.aborted) throw new GhostError("SITE_UNREACHABLE");
        if (attempt >= limits.maxRetries) {
          throw new GhostError("SITE_UNREACHABLE");
        }
        retry = true;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
        // The gap is measured from the end of the response, body included.
        lastRequestAt = now();
      }
      if (retry) {
        await wait(waitMs);
        attempt += 1;
      }
    }
  }

  async function getJson(
    route: string,
    params?: Record<string, string | number>,
  ): Promise<GhostJson | GhostNotFound> {
    if (
      typeof input.key !== "string" ||
      input.key.length === 0 ||
      input.key.length > MAX_KEY_LENGTH
    ) {
      throw new GhostError("BAD_CREDENTIALS");
    }
    const url = buildUrl(siteBase, input.key, route, params);
    const { status, bytes } = await perform(url);
    if (status === 200) {
      let body: unknown;
      try {
        body = JSON.parse(decode(bytes));
      } catch {
        throw new GhostError("NOT_A_GHOST_SITE");
      }
      return { body };
    }
    if (status === 401) throw new GhostError("BAD_CREDENTIALS");
    if (status === 403) {
      throw new GhostError(
        isUnknownKey(bytes) ? "BAD_CREDENTIALS" : "NOT_A_GHOST_SITE",
      );
    }
    if (status === 404) {
      // The readiness route missing means there is no Content API at all; any
      // other missing route is the caller's to interpret (a gone item).
      if (route === "settings") throw new GhostError("NOT_A_GHOST_SITE");
      return new GhostNotFound();
    }
    throw new GhostError("BAD_RESPONSE");
  }

  const typeOf = (route: GhostItemRoute): GhostContentType =>
    route === "pages" ? "page" : "post";

  function pageNumber(page: number): number {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new RangeError("page must be a positive integer");
    }
    return page;
  }

  /** `id:[a,b]` style value for validated 24-hex ids (never interpolates an
   * unchecked value into a filter). */
  function idList(ids: string[]): string {
    if (ids.length === 0 || ids.length > ID_BATCH) {
      throw new RangeError(`ids must hold 1 to ${ID_BATCH} entries`);
    }
    for (const id of ids) {
      if (typeof id !== "string" || !ID_FORMAT.test(id)) {
        throw new GhostError("CONFIG_INVALID");
      }
    }
    return `[${ids.join(",")}]`;
  }

  /** The body of a list route as an object; a missing route is a bad answer. */
  async function getList(
    route: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    const res = await getJson(route, params);
    if (isNotFound(res) || !isRecord(res.body)) {
      throw new GhostError("BAD_RESPONSE");
    }
    return res.body;
  }

  async function readItems(
    route: GhostItemRoute,
    page: number,
    filter: string | null,
  ): Promise<ListItemsResult> {
    const params: Record<string, string | number> = {
      fields: LIST_FIELDS,
      include: "tags",
      order: "id asc",
      limit: PAGE_SIZE,
      page: pageNumber(page),
    };
    if (filter !== null) params.filter = filter;
    const body = await getList(route, params);
    const rows = body[route];
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
      throw new GhostError("BAD_RESPONSE");
    }
    const { total, pages } = parsePagination(body);
    const type = typeOf(route);
    return { items: rows.map((row) => parseListItem(row, type)), total, pages };
  }

  async function listItems(
    route: GhostItemRoute,
    params: ListItemsParams,
  ): Promise<ListItemsResult> {
    if (params.tagIds !== undefined && params.ids !== undefined) {
      throw new RangeError("tagIds and ids cannot be combined");
    }
    let filter: string | null = null;
    if (params.tagIds !== undefined)
      filter = `tags.id:${idList(params.tagIds)}`;
    else if (params.ids !== undefined) filter = `id:${idList(params.ids)}`;
    return readItems(route, params.page, filter);
  }

  async function getItem(
    route: GhostItemRoute,
    id: string,
  ): Promise<GhostItem | null> {
    if (typeof id !== "string" || !ID_FORMAT.test(id)) {
      throw new GhostError("CONFIG_INVALID");
    }
    // No `fields` here: with `tags` or `authors` it breaks the single route.
    const res = await getJson(`${route}/${id}`, {
      formats: "html",
      include: "tags,authors",
    });
    if (isNotFound(res)) return null;
    const rows = isRecord(res.body) ? res.body[route] : undefined;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new GhostError("BAD_RESPONSE");
    }
    const item = parseItem(rows[0], typeOf(route));
    // A site answering another item's body is not trusted.
    if (item.id !== id) throw new GhostError("BAD_RESPONSE");
    return item;
  }

  async function listTags(
    page: number,
  ): Promise<{ tags: GhostTag[]; pages: number }> {
    const body = await getList("tags", {
      fields: "id,slug,name",
      order: "id asc",
      limit: PAGE_SIZE,
      page: pageNumber(page),
    });
    const rows = body.tags;
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
      throw new GhostError("BAD_RESPONSE");
    }
    return { tags: rows.map(parseTag), pages: parsePagination(body).pages };
  }

  async function listTagsByIds(ids: string[]): Promise<GhostTag[]> {
    const filter = `id:${idList(ids)}`;
    const body = await getList("tags", {
      fields: "id,slug,name",
      filter,
      order: "id asc",
      limit: PAGE_SIZE,
      page: 1,
    });
    const rows = body.tags;
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
      throw new GhostError("BAD_RESPONSE");
    }
    return rows.map(parseTag);
  }

  async function getSettings(): Promise<{ title: string | null }> {
    const res = await getJson("settings");
    if (isNotFound(res)) throw new GhostError("NOT_A_GHOST_SITE");
    const settings = isRecord(res.body) ? res.body.settings : undefined;
    if (!isRecord(settings)) throw new GhostError("NOT_A_GHOST_SITE");
    const title =
      typeof settings.title === "string" ? oneLine(settings.title) : "";
    return { title: title === "" ? null : title.slice(0, 200) };
  }

  async function searchContent(
    query: string,
    route: GhostItemRoute,
    page: number,
  ): Promise<ListItemsResult> {
    const text = typeof query === "string" ? oneLine(query) : "";
    if (text === "" || text.length > MAX_QUERY_LENGTH) {
      throw new GhostError("CONFIG_INVALID");
    }
    // NQL string literal: the backslash first, so an escape cannot be undone,
    // then the quote that would end the literal.
    const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return readItems(route, page, `title:~'${escaped}'`);
  }

  return {
    getJson,
    listItems,
    getItem,
    listTags,
    listTagsByIds,
    getSettings,
    searchContent,
    requestCount: () => requestCount,
  };
}

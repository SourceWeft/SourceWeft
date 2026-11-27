import {
  asWordPressRestCode,
  WordPressError,
  type WordPressErrorCode,
  type WordPressRestCode,
} from "./errors";
import {
  MAX_CATEGORY_PAGES,
  MAX_RESPONSE_BYTES,
  MAX_TAG_IDS,
  PER_PAGE,
  WORDPRESS_USER_AGENT,
} from "./limits";
import {
  parseListItem,
  parseMe,
  parsePost,
  parseSearchHit,
  parseTerm,
  parseUser,
  type WpListItem,
  type WpMe,
  type WpPost,
  type WpSearchHit,
  type WpTerm,
} from "./model";
import { discoverWith, routeUrl, type RestRoot } from "./rest-root";
import { parseSiteUrl, siteHostOf } from "./site-url";
import {
  abortable,
  createTransport,
  discard,
  type ClientLimits,
} from "./transport";

export type { ClientLimits } from "./transport";

/** The REST root index: the site name and the namespaces it exposes. */
export type WpIndex = { name: string | null; namespaces: string[] };

/** One list or single read: the parsed body and the paging totals, when sent. */
export type WordPressJson = {
  body: unknown;
  total: number | null;
  totalPages: number | null;
};

/** The route (a post, page, category…) does not exist (404); the caller
 * decides whether that is a gone item or a bad listing, like Discourse's. */
export class WordPressNotFound {
  readonly kind = "not_found" as const;
}

export function isNotFound(value: unknown): value is WordPressNotFound {
  return value instanceof WordPressNotFound;
}

/** A page of a listing with the totals the site reported. */
export type WpPage<T> = { items: T[]; total: number; totalPages: number };

export type ListItemsParams = {
  /** 1-based page number. */
  page: number;
  /** Posts only: restrict to these category ids (a non-empty list). */
  categories?: number[];
  /**
   * Ask for draft, private, pending and future content as well. Only the login
   * connector may set this; without it no `status` parameter is ever sent, so
   * the public path cannot ask for unpublished content.
   */
  includeUnpublished: boolean;
};

export type WordPressClient = {
  /** The discovered REST root; cached for the client's life. */
  discover(): Promise<RestRoot>;
  /** The root index, requiring `wp/v2` among its namespaces (else REST_DISABLED). */
  getIndex(): Promise<WpIndex>;
  /** A GET of a `/wp/v2/...` route; a 404 is {@link WordPressNotFound}. */
  getJson(
    route: string,
    params?: Record<string, string | number>,
  ): Promise<WordPressJson | WordPressNotFound>;
  /** Requests this client has issued, discovery included. */
  requestCount(): number;
  /** One page of `posts` or `pages` (list fields only). */
  listItems(
    route: "posts" | "pages",
    params: ListItemsParams,
  ): Promise<WpPage<WpListItem>>;
  /** One post or page with its body; `null` when it does not exist (404), or
   * when it is not published and `includeUnpublished` is false. */
  getItem(
    route: "posts" | "pages",
    id: number,
    includeUnpublished: boolean,
  ): Promise<WpPost | null>;
  /** Every category, at most {@link MAX_CATEGORY_PAGES} pages (else TOO_LARGE). */
  listCategories(): Promise<WpTerm[]>;
  /** The tags with these ids, in batches of {@link PER_PAGE}. */
  listTags(ids: number[]): Promise<WpTerm[]>;
  /** Best effort id to name map: a hidden or missing `users` route gives an empty map. */
  listUsers(ids: number[]): Promise<Map<number, string>>;
  /** The signed-in user and its capabilities (`users/me?context=edit`). */
  getMe(): Promise<WpMe>;
  /** One page of a title search over posts and pages. */
  searchContent(query: string, page: number): Promise<WpPage<WpSearchHit>>;
};

export type CreateWordPressClientInput = {
  /** The host fetch scope: public for the anonymous connector, credentialed for
   * the login connector. It owns the address policy. */
  fetch: typeof fetch;
  /** A site base as `parseSiteUrl` returns it. */
  siteBase: string;
  /** Whether the hosted wordpress.com route is accepted (public connector only). */
  allowWpcom: boolean;
  /** A ready-made `Authorization` value (e.g. `Basic …`); sent only to the site
   * origin. The login connector supplies it; the public connector omits it. */
  authorization?: string;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  limits?: Partial<ClientLimits>;
};

// ------------------------------------------------------- typed read helpers

type GetJson = (
  route: string,
  params?: Record<string, string | number>,
) => Promise<WordPressJson | WordPressNotFound>;

const LIST_FIELDS =
  "id,modified_gmt,link,title,status,type,categories,tags,author";
const FULL_FIELDS = `${LIST_FIELDS},content,slug,date_gmt`;
const UNPUBLISHED_STATUSES = "publish,private,draft,pending,future";
/** Longest title search a member can send. */
const SEARCH_QUERY_MAX = 500;

/** REST codes of a 401/403 that say the credential is valid but lacks rights. */
const RIGHTS_CODES: ReadonlySet<WordPressRestCode> = new Set([
  "rest_cannot_view",
  "rest_forbidden",
  "rest_user_cannot_view",
]);

function bad(): WordPressError {
  return new WordPressError("BAD_RESPONSE");
}

function invalid(): WordPressError {
  return new WordPressError("CONFIG_INVALID");
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Distinct, validated ids; a bad id is a programming error (CONFIG_INVALID). */
function distinctIds(ids: number[]): number[] {
  const seen = new Set<number>();
  for (const id of ids) {
    if (!isId(id)) throw invalid();
    seen.add(id);
  }
  return [...seen];
}

/**
 * When unpublished content was asked for, a site that refuses the `status`
 * filter (400 `rest_forbidden_status`) or a valid login without the rights
 * (401/403 `rest_cannot_view`, `rest_forbidden`, `rest_user_cannot_view`) is
 * `INSUFFICIENT_PERMISSION`, not a bad response or a login prompt. Wrong
 * credentials and login walls keep their own codes.
 */
async function withUnpublishedMapping<T>(
  includeUnpublished: boolean,
  run: () => Promise<T>,
): Promise<T> {
  if (!includeUnpublished) return run();
  try {
    return await run();
  } catch (error) {
    if (error instanceof WordPressError) {
      const forbiddenStatus =
        error.code === "BAD_RESPONSE" &&
        error.restCode === "rest_forbidden_status";
      const lacksRights =
        error.code === "LOGIN_REQUIRED" &&
        error.restCode !== undefined &&
        RIGHTS_CODES.has(error.restCode);
      if (forbiddenStatus || lacksRights) {
        throw new WordPressError("INSUFFICIENT_PERMISSION");
      }
    }
    throw error;
  }
}

/** A listing answer: an array of at most one page, and the paging totals. */
function listing(result: WordPressJson | WordPressNotFound): {
  rows: unknown[];
  total: number;
  totalPages: number;
} {
  if (isNotFound(result)) throw bad();
  const { body, total, totalPages } = result;
  if (!Array.isArray(body) || body.length > PER_PAGE) throw bad();
  if (total === null || totalPages === null) throw bad();
  return { rows: body, total, totalPages };
}

function createContentHelpers(
  getJson: GetJson,
): Pick<
  WordPressClient,
  | "listItems"
  | "getItem"
  | "listCategories"
  | "listTags"
  | "listUsers"
  | "getMe"
  | "searchContent"
> {
  const typeOf = (route: "posts" | "pages") =>
    route === "posts" ? "post" : "page";

  async function termBatch(
    route: "/wp/v2/tags" | "/wp/v2/users",
    ids: number[],
  ): Promise<WordPressJson | WordPressNotFound> {
    return getJson(route, {
      include: ids.join(","),
      per_page: PER_PAGE,
      _fields: "id,name",
    });
  }

  return {
    async listItems(route, params) {
      if (!isId(params.page)) throw invalid();
      const query: Record<string, string | number> = {
        per_page: PER_PAGE,
        page: params.page,
        orderby: "id",
        order: "asc",
        _fields: LIST_FIELDS,
      };
      if (params.categories !== undefined) {
        if (route !== "posts" || params.categories.length === 0) {
          throw invalid();
        }
        query.categories = distinctIds(params.categories).join(",");
      }
      if (params.includeUnpublished) query.status = UNPUBLISHED_STATUSES;
      return withUnpublishedMapping(params.includeUnpublished, async () => {
        const { rows, total, totalPages } = listing(
          await getJson(`/wp/v2/${route}`, query),
        );
        const items = rows.map(parseListItem);
        if (items.some((item) => item.type !== typeOf(route))) throw bad();
        return { items, total, totalPages };
      });
    },

    async getItem(route, id, includeUnpublished) {
      if (!isId(id)) throw invalid();
      return withUnpublishedMapping(includeUnpublished, async () => {
        const result = await getJson(`/wp/v2/${route}/${id}`, {
          _fields: FULL_FIELDS,
        });
        if (isNotFound(result)) return null;
        const post = parsePost(result.body);
        if (post.id !== id || post.type !== typeOf(route)) throw bad();
        // A login that can read a draft by id must not index it unasked.
        if (!includeUnpublished && post.status !== "publish") return null;
        return post;
      });
    },

    async listCategories() {
      const categories: WpTerm[] = [];
      let totalPages = 1;
      for (let page = 1; page <= totalPages; page += 1) {
        const result = listing(
          await getJson("/wp/v2/categories", {
            per_page: PER_PAGE,
            page,
            orderby: "id",
            order: "asc",
            _fields: "id,name,parent",
          }),
        );
        totalPages = Math.max(1, result.totalPages);
        if (totalPages > MAX_CATEGORY_PAGES) {
          throw new WordPressError("TOO_LARGE");
        }
        categories.push(...result.rows.map(parseTerm));
      }
      return categories;
    },

    async listTags(ids) {
      const wanted = distinctIds(ids);
      if (wanted.length > MAX_TAG_IDS) throw new WordPressError("TOO_LARGE");
      const tags: WpTerm[] = [];
      for (let start = 0; start < wanted.length; start += PER_PAGE) {
        const result = await termBatch(
          "/wp/v2/tags",
          wanted.slice(start, start + PER_PAGE),
        );
        if (isNotFound(result)) throw bad();
        if (!Array.isArray(result.body) || result.body.length > PER_PAGE) {
          throw bad();
        }
        tags.push(...result.body.map(parseTerm));
      }
      return tags;
    },

    async listUsers(ids) {
      const wanted = distinctIds(ids);
      const names = new Map<number, string>();
      try {
        for (let start = 0; start < wanted.length; start += PER_PAGE) {
          const result = await termBatch(
            "/wp/v2/users",
            wanted.slice(start, start + PER_PAGE),
          );
          if (isNotFound(result)) return new Map();
          if (!Array.isArray(result.body) || result.body.length > PER_PAGE) {
            throw bad();
          }
          for (const row of result.body) {
            const user = parseUser(row);
            names.set(user.id, user.name);
          }
        }
      } catch (error) {
        // Author names are best effort: a site that hides its users (401/403)
        // simply has none.
        if (
          error instanceof WordPressError &&
          (error.code === "LOGIN_REQUIRED" || error.code === "BAD_CREDENTIALS")
        ) {
          return new Map();
        }
        throw error;
      }
      return names;
    },

    async getMe() {
      const result = await getJson("/wp/v2/users/me", {
        context: "edit",
        _fields: "id,name,capabilities",
      });
      if (isNotFound(result)) throw bad();
      return parseMe(result.body);
    },

    async searchContent(query, page) {
      const search = query.trim();
      if (search === "" || search.length > SEARCH_QUERY_MAX || !isId(page)) {
        throw invalid();
      }
      const { rows, total, totalPages } = listing(
        await getJson("/wp/v2/search", {
          search,
          type: "post",
          subtype: "post,page",
          per_page: PER_PAGE,
          page,
          _fields: "id,title,url,type,subtype",
        }),
      );
      return { items: rows.map(parseSearchHit), total, totalPages };
    },
  };
}

/** Error bodies (400/401/403/404) are read only for a REST `code`; this is plenty. */
const ERROR_BODY_BYTES = 65_536;

/** Reads at most `maxBytes` bytes and cancels the stream the moment one more
 * arrives, so a hostile body is never fully read. Over the cap is TOO_LARGE. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const tooLarge = () => new WordPressError("TOO_LARGE");
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

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** The first recognised code under `data.details.*` of a `rest_invalid_param`
 * body (e.g. `rest_forbidden_status`), or `undefined`. */
function nestedDetailCode(
  body: Record<string, unknown>,
): WordPressRestCode | undefined {
  const data = body.data;
  if (!isRecord(data)) return undefined;
  const details = data.details;
  if (!isRecord(details)) return undefined;
  for (const value of Object.values(details)) {
    if (isRecord(value)) {
      const code = asWordPressRestCode(value.code);
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

/** Parses an error body once: the raw top-level `code` (for the login/permission
 * decision) and a recognised {@link WordPressRestCode} (for later tasks). An
 * unrecognised code or a non-JSON body leaves `restCode` unset; nothing but the
 * closed enum value is ever recorded. */
function parseError(bytes: Uint8Array): {
  rawCode: string | null;
  restCode: WordPressRestCode | undefined;
} {
  let body: unknown;
  try {
    body = JSON.parse(decode(bytes));
  } catch {
    return { rawCode: null, restCode: undefined };
  }
  if (!isRecord(body)) return { rawCode: null, restCode: undefined };
  const rawCode = typeof body.code === "string" ? body.code : null;
  const top = asWordPressRestCode(rawCode);
  const restCode =
    top === "rest_invalid_param" ? (nestedDetailCode(body) ?? top) : top;
  return { rawCode, restCode };
}

/**
 * Maps a 401/403 to a login prompt or a credential failure (spec "Errors").
 *
 * For a credentialed request, any 401 is a credential failure: the request
 * carried an Application Password, so a 401 — whatever its `rest_*` code,
 * including `rest_not_logged_in`/`rest_login_required` — means the credential
 * was rejected or never reached WordPress (a host stripping the `Authorization`
 * header is the common case), not a public-style login wall. A credentialed
 * 403 keeps its mapping (a rights refusal, mapped to INSUFFICIENT_PERMISSION by
 * {@link withUnpublishedMapping} when unpublished content was asked for). The
 * public path is unchanged: with no credential, every 401/403 is LOGIN_REQUIRED.
 */
function authError(
  status: number,
  code: string | null,
  credentialed: boolean,
): WordPressErrorCode {
  if (credentialed) {
    if (code === "incorrect_password" || code === "invalid_username") {
      return "BAD_CREDENTIALS";
    }
    if (status === 401) return "BAD_CREDENTIALS";
  }
  return "LOGIN_REQUIRED";
}

function intHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  return Number(trimmed);
}

type RawResponse = { status: number; headers: Headers; bytes: Uint8Array };

/**
 * A read-only client for a WordPress REST site. Every URL is built from the
 * validated site base, the discovered REST root and a fixed `/wp/v2` route:
 * nothing in a response body is ever requested. The `Authorization` value is
 * attached only to requests whose origin equals the site origin, so a
 * credential never leaves the site (and discovery sends none). Every failure is
 * a {@link WordPressError} with a fixed message: the site address, the
 * credential and the body are never forwarded, and no `cause` is set. A 400/
 * 401/403/404 error also records a recognised {@link WordPressRestCode} so a
 * later task can map a more precise outcome without re-reading the body.
 */
export function createWordPressClient(
  input: CreateWordPressClientInput,
): WordPressClient {
  const siteBase = parseSiteUrl(input.siteBase);
  const siteOrigin = `https://${siteHostOf(siteBase)}`;
  const maxBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const transport = createTransport({
    fetch: input.fetch,
    now: input.now,
    sleep: input.sleep,
    signal: input.signal,
    requestTimeoutMs: input.requestTimeoutMs,
    limits: input.limits,
  });

  let rootPromise: Promise<RestRoot> | null = null;

  /** The credential, but only when the request stays on the site's origin. */
  function authorizationFor(url: string): string | undefined {
    if (input.authorization === undefined) return undefined;
    try {
      return new URL(url).origin === siteOrigin
        ? input.authorization
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** One GET over the shared transport. The transport owns the budget, gap,
   * retries and the 3xx/429/network outcomes; this handler reads the final
   * 200/4xx/5xx body (capped) and hands the status back for mapping. */
  function perform(
    url: string,
    authorization: string | undefined,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": WORDPRESS_USER_AGENT,
    };
    if (authorization !== undefined) headers.Authorization = authorization;
    return transport.request(url, headers, async (response, signal) => {
      const { status } = response;
      if (status === 200) {
        const bytes = await readCapped(response, maxBytes, signal);
        return { status, headers: response.headers, bytes };
      }
      if (status >= 500) {
        await discard(response);
        return { status, headers: response.headers, bytes: new Uint8Array(0) };
      }
      const bytes = await readCapped(
        response,
        Math.min(maxBytes, ERROR_BODY_BYTES),
        signal,
      );
      return { status, headers: response.headers, bytes };
    });
  }

  function indexUrl(root: RestRoot): string {
    switch (root.kind) {
      case "pretty":
        return `${root.base}/`;
      case "plain":
        return root.index;
      case "wpcom":
        return `https://public-api.wordpress.com/wp-json/?rest_route=/sites/${root.host}`;
    }
  }

  function discover(): Promise<RestRoot> {
    // The client's own transport, so a discovery request counts against the
    // same budget and gap as every REST read (it still sends no credential).
    return (rootPromise ??= discoverWith(transport, {
      siteBase,
      allowWpcom: input.allowWpcom,
    }));
  }

  async function getJson(
    route: string,
    params?: Record<string, string | number>,
  ): Promise<WordPressJson | WordPressNotFound> {
    const root = await discover();
    const url = routeUrl(root, route, params);
    const authorization = authorizationFor(url);
    const { status, headers, bytes } = await perform(url, authorization);
    if (status === 200) {
      let body: unknown;
      try {
        body = JSON.parse(decode(bytes));
      } catch {
        throw new WordPressError("NOT_A_WORDPRESS_SITE");
      }
      return {
        body,
        total: intHeader(headers, "x-wp-total"),
        totalPages: intHeader(headers, "x-wp-totalpages"),
      };
    }
    if (status === 404) return new WordPressNotFound();
    const { rawCode, restCode } = parseError(bytes);
    if (status === 401 || status === 403) {
      throw new WordPressError(
        authError(status, rawCode, authorization !== undefined),
        restCode,
      );
    }
    throw new WordPressError(
      "BAD_RESPONSE",
      status === 400 ? restCode : undefined,
    );
  }

  const content = createContentHelpers(getJson);

  return {
    discover,
    ...content,

    async getIndex() {
      const root = await discover();
      const url = indexUrl(root);
      const authorization = authorizationFor(url);
      const { status, bytes } = await perform(url, authorization);
      if (status === 200) {
        let body: unknown;
        try {
          body = JSON.parse(decode(bytes));
        } catch {
          throw new WordPressError("NOT_A_WORDPRESS_SITE");
        }
        if (!isRecord(body)) throw new WordPressError("NOT_A_WORDPRESS_SITE");
        const namespaces = Array.isArray(body.namespaces)
          ? body.namespaces.filter((n): n is string => typeof n === "string")
          : [];
        if (!namespaces.includes("wp/v2")) {
          throw new WordPressError("REST_DISABLED");
        }
        const name = typeof body.name === "string" ? body.name : null;
        return { name, namespaces };
      }
      const { rawCode, restCode } = parseError(bytes);
      if (status === 401 || status === 403) {
        throw new WordPressError(
          authError(status, rawCode, authorization !== undefined),
          restCode,
        );
      }
      if (status === 404) {
        throw new WordPressError("NOT_A_WORDPRESS_SITE", restCode);
      }
      throw new WordPressError(
        "BAD_RESPONSE",
        status === 400 ? restCode : undefined,
      );
    },

    getJson,

    requestCount() {
      return transport.requestCount();
    },
  };
}

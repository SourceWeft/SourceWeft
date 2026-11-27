/**
 * An in-process fake of the Ghost Content API, exposed as a `fetch`. There are
 * no sockets: the fake is a function over `(url, init)` that records every
 * request and answers from a {@link FakeGhostState}. It follows what a real
 * Ghost answers (verified against demo.ghost.io, Ghost 6, API v5, 2026-11-27):
 *
 * - routes live under `<siteBase>/ghost/api/content/<route>/`; the same URL
 *   without the trailing slash answers 301 to the slash form, query string
 *   included (a client that followed it would carry the key along);
 * - the Content API key is accepted only as the `key` query parameter. Without
 *   it (headers are ignored) the answer is 403; a wrong key is 403 with the
 *   error code `UNKNOWN_CONTENT_API_KEY`;
 * - lists return `{ posts|pages|tags|authors: [...], meta: { pagination } }`
 *   with `pagination = { page, limit, pages, total, next, prev }`; `limit` is
 *   clamped to 100; `fields`, `include` (`tags`, `authors`), `order` and the
 *   `filter` forms `tag:<slug>`, `tags.id:[…]`, `id:[…]` and `title:~'…'` work;
 * - a post the key cannot read in full (`access: false`) carries a teaser as
 *   its `html`;
 * - the single-item route answers 404 for a missing id and 400 when `fields`
 *   names `tags` or `authors`;
 * - `GET settings/` answers `{ settings: {...}, meta: {} }`.
 *
 * Faults (status overrides, network errors, hangs, redirects), header
 * mutations, a `beforeRequest` hook and direct state mutation are available to
 * a test, in the style of `fake-wordpress.ts`.
 */

export type FakeVisibility = "public" | "members" | "paid" | "tiers";

export type FakeTag = {
  /** 24 lower-case hex characters. */
  id: string;
  name: string;
  slug?: string;
};

export type FakeAuthor = { id: string; name: string; slug?: string };

export type FakeItem = {
  /** 24 lower-case hex characters. */
  id: string;
  type?: "post" | "page";
  title?: string;
  slug?: string;
  /** Full body. For an unreadable item the response carries `teaser` instead. */
  html?: string;
  /** Replaces the default teaser served when `access` is false. */
  teaser?: string;
  /**
   * The `url` the site reports. Defaults to `<siteBase>/<slug>/`; any string
   * may be given, so a test can serve hostile values.
   */
  url?: string;
  visibility?: FakeVisibility;
  /** Defaults to `visibility === "public"`. */
  access?: boolean;
  updated_at?: string;
  published_at?: string;
  canonical_url?: string | null;
  /** Tag ids, in order. */
  tags?: string[];
  /** Author ids, in order. */
  authors?: string[];
  /** A `draft` item is never served by the Content API. */
  status?: "published" | "draft";
};

export type FakeGhostState = {
  items: FakeItem[];
  tags: FakeTag[];
  authors: FakeAuthor[];
  /** The `settings` object `GET settings/` returns. */
  settings: Record<string, unknown>;
};

/** What the whole site answers instead of Ghost. */
export type NotGhostMode = "html" | "not-found";

export type FakeGhostOptions = {
  /** The validated site base, e.g. `https://site.example` or `.../blog`. */
  siteBase: string;
  /** The accepted Content API key; default {@link DEFAULT_KEY}. */
  key?: string;
  items?: FakeItem[];
  tags?: FakeTag[];
  authors?: FakeAuthor[];
  settings?: Record<string, unknown>;
  /** The site is not Ghost: every request is answered with HTML or a 404. */
  notGhost?: NotGhostMode;
  /** Runs before each request is served; may mutate the state. */
  beforeRequest?: (request: RecordedRequest, fake: FakeGhost) => void;
};

export type RecordedRequest = {
  method: string;
  /** Full URL as requested. */
  url: string;
  /** Lower-cased host. */
  host: string;
  /** Path without the query. */
  path: string;
  /** Decoded query parameters (last value of a repeated name wins). */
  query: Record<string, string>;
  /** Every decoded value of every query parameter. */
  queryAll: Record<string, string[]>;
  /** Lower-cased request header names to values. */
  headers: Record<string, string>;
  /** The RequestInit keys the caller passed. */
  initKeys: string[];
  /** The `redirect` mode the caller asked for, if any. */
  redirect: string | undefined;
};

export type FakeFault =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { networkError: true }
  /** Never answer; rejects with an AbortError when the request's signal aborts. */
  | { hang: true };

export type FakeGhost = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** The live state; mutate it directly or through {@link setState}. */
  state: FakeGhostState;
  setState(state: Partial<FakeGhostState>): void;
  /** The next `times` requests (optionally only those matching) get `fault`. */
  failNext(
    fault: FakeFault,
    times?: number,
    match?: (request: RecordedRequest) => boolean,
  ): void;
  /** The next `times` requests answer 429 with a `Retry-After` of `seconds`. */
  rateLimitNext(seconds: number | string, times?: number): void;
  /** The next `times` requests answer a redirect to `location`. */
  redirectNext(location: string, times?: number, status?: number): void;
  /** Set (string) or remove (null) response headers on the next `times` served responses. */
  mutateNext(headers: Record<string, string | null>, times?: number): void;
  /** Replaces the `beforeRequest` hook (or removes it with `undefined`). */
  onBeforeRequest(hook: FakeGhostOptions["beforeRequest"]): void;
};

/** The public demo key shape: 26 lower-case hex characters. */
export const DEFAULT_KEY = "22444f78447824223cefc48062";

const DATE = "2026-01-01T00:00:00.000Z";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 15;

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function errorBody(
  status: number,
  type: string,
  message: string,
  code: string | null = null,
): Response {
  return json({ errors: [{ message, type, code }] }, status);
}

function basePathOf(siteBase: string): string {
  const path = new URL(siteBase).pathname;
  return path === "/" ? "" : path.replace(/\/$/, "");
}

/** Keeps only the `fields` the request asked for, as the real API does. */
function pick(
  fields: string | undefined,
  extra: string[],
  object: Record<string, unknown>,
): Record<string, unknown> {
  if (fields === undefined || fields === "") return object;
  const wanted = new Set([
    ...fields.split(",").map((f) => f.trim()),
    // `include`d relations are always kept.
    ...extra,
  ]);
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => wanted.has(key)),
  );
}

type Clause =
  | { kind: "tag"; slug: string }
  | { kind: "tagIds"; ids: string[] }
  | { kind: "ids"; ids: string[] }
  | { kind: "title"; text: string };

/** Parses the filter forms the connector uses; `null` for anything else. */
function parseFilter(raw: string): Clause | null {
  const list = (body: string): string[] | null => {
    const m = /^\[([^\]]*)\]$/.exec(body);
    if (m === null) return null;
    const inner = m[1] as string;
    return inner === "" ? [] : inner.split(",").map((s) => s.trim());
  };
  const tagIds = /^tags\.id:(\[.*\])$/.exec(raw);
  if (tagIds) {
    const ids = list(tagIds[1] as string);
    return ids === null ? null : { kind: "tagIds", ids };
  }
  const ids = /^id:(\[.*\])$/.exec(raw);
  if (ids) {
    const parsed = list(ids[1] as string);
    return parsed === null ? null : { kind: "ids", ids: parsed };
  }
  const tag = /^tag:([A-Za-z0-9_-]+)$/.exec(raw);
  if (tag) return { kind: "tag", slug: tag[1] as string };
  const title = /^title:~'((?:[^'\\]|\\.)*)'$/.exec(raw);
  if (title) {
    return {
      kind: "title",
      text: (title[1] as string).replace(/\\(.)/g, "$1"),
    };
  }
  return null;
}

export function createFakeGhost(options: FakeGhostOptions): FakeGhost {
  const siteBase = options.siteBase.replace(/\/$/, "");
  const siteHost = new URL(siteBase).host.toLowerCase();
  const basePath = basePathOf(siteBase);
  const apiPrefix = `${basePath}/ghost/api/content`;
  const key = options.key ?? DEFAULT_KEY;

  const state: FakeGhostState = {
    items: options.items ?? [],
    tags: options.tags ?? [],
    authors: options.authors ?? [],
    settings: options.settings ?? {
      title: "Example",
      description: "An example Ghost site",
      url: siteBase,
    },
  };

  const requests: RecordedRequest[] = [];
  const faults: {
    fault: FakeFault;
    left: number;
    match?: (request: RecordedRequest) => boolean;
  }[] = [];
  const mutations: { headers: Record<string, string | null>; left: number }[] =
    [];
  let hook = options.beforeRequest;

  const tagById = (id: string) => state.tags.find((t) => t.id === id);
  const authorById = (id: string) => state.authors.find((a) => a.id === id);

  const tagSlug = (t: FakeTag) => t.slug ?? `tag-${t.id.slice(-4)}`;

  function tagObject(t: FakeTag): Record<string, unknown> {
    const slug = tagSlug(t);
    return {
      id: t.id,
      name: t.name,
      slug,
      description: null,
      visibility: "public",
      url: `${siteBase}/tag/${slug}/`,
    };
  }

  function authorObject(a: FakeAuthor): Record<string, unknown> {
    const slug = a.slug ?? `author-${a.id.slice(-4)}`;
    return {
      id: a.id,
      name: a.name,
      slug,
      url: `${siteBase}/author/${slug}/`,
    };
  }

  function itemObject(
    item: FakeItem,
    include: Set<string>,
  ): Record<string, unknown> {
    const slug = item.slug ?? `item-${item.id.slice(-4)}`;
    const visibility = item.visibility ?? "public";
    const access = item.access ?? visibility === "public";
    const html = item.html ?? `<p>Body ${item.id}</p>`;
    const teaser = item.teaser ?? "<p>Teaser. Sign up to read more.</p>";
    const object: Record<string, unknown> = {
      id: item.id,
      uuid: `uuid-${item.id}`,
      title: item.title ?? `Item ${item.id}`,
      slug,
      html: access ? html : teaser,
      url: item.url ?? `${siteBase}/${slug}/`,
      excerpt: "Excerpt.",
      visibility,
      access,
      featured: false,
      created_at: DATE,
      updated_at: item.updated_at ?? DATE,
      published_at: item.published_at ?? DATE,
      canonical_url: item.canonical_url ?? null,
    };
    if (include.has("tags")) {
      object.tags = (item.tags ?? [])
        .map(tagById)
        .filter((t): t is FakeTag => t !== undefined)
        .map(tagObject);
    }
    if (include.has("authors")) {
      object.authors = (item.authors ?? [])
        .map(authorById)
        .filter((a): a is FakeAuthor => a !== undefined)
        .map(authorObject);
    }
    return object;
  }

  function includeOf(request: RecordedRequest): Set<string> {
    const raw = request.query.include ?? "";
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    );
  }

  function paginate<T>(
    all: T[],
    request: RecordedRequest,
  ): { page: T[]; pagination: Record<string, unknown> } {
    const asked = Number(request.query.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(asked)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(asked)))
      : DEFAULT_LIMIT;
    const pageNo = Math.max(
      1,
      Math.trunc(Number(request.query.page ?? 1)) || 1,
    );
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const start = (pageNo - 1) * limit;
    return {
      page: all.slice(start, start + limit),
      pagination: {
        page: pageNo,
        limit,
        pages,
        total,
        next: pageNo < pages ? pageNo + 1 : null,
        prev: pageNo > 1 ? pageNo - 1 : null,
      },
    };
  }

  function sorted<T extends Record<string, unknown>>(
    rows: T[],
    order: string | undefined,
    fallback: string,
  ): T[] | null {
    const m = /^(id|published_at|updated_at|title|name)\s+(asc|desc)$/i.exec(
      (order ?? fallback).trim(),
    );
    if (m === null) return null;
    const field = (m[1] as string).toLowerCase();
    const dir = (m[2] as string).toLowerCase() === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = String(a[field] ?? "");
      const bv = String(b[field] ?? "");
      if (av !== bv) return av < bv ? -dir : dir;
      const ai = String(a.id);
      const bi = String(b.id);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  }

  function badFilter(): Response {
    return errorBody(
      400,
      "IncorrectUsageError",
      "Error parsing filter",
      "FILTER_NOT_SUPPORTED_BY_THE_FAKE",
    );
  }

  function serveItems(
    type: "post" | "page",
    request: RecordedRequest,
  ): Response {
    const include = includeOf(request);
    let items = state.items.filter(
      (i) =>
        (i.type ?? "post") === type &&
        (i.status ?? "published") === "published",
    );
    const raw = request.query.filter;
    if (raw !== undefined && raw !== "") {
      const clause = parseFilter(raw);
      if (clause === null) return badFilter();
      switch (clause.kind) {
        case "tag": {
          const ids = new Set(
            state.tags
              .filter((t) => tagSlug(t) === clause.slug)
              .map((t) => t.id),
          );
          items = items.filter((i) => (i.tags ?? []).some((t) => ids.has(t)));
          break;
        }
        case "tagIds":
          items = items.filter((i) =>
            (i.tags ?? []).some((t) => clause.ids.includes(t)),
          );
          break;
        case "ids":
          items = items.filter((i) => clause.ids.includes(i.id));
          break;
        case "title":
          items = items.filter((i) =>
            (i.title ?? `Item ${i.id}`)
              .toLowerCase()
              .includes(clause.text.toLowerCase()),
          );
          break;
      }
    }
    const objects = items.map((i) => itemObject(i, new Set()));
    const ordered = sorted(objects, request.query.order, "published_at desc");
    if (ordered === null) return badFilter();
    const { page, pagination } = paginate(ordered, request);
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = page.map((o) => {
      const item = byId.get(String(o.id)) as FakeItem;
      const withRelations = itemObject(item, include);
      return pick(request.query.fields, [...include], withRelations);
    });
    return json({
      [type === "post" ? "posts" : "pages"]: rows,
      meta: { pagination },
    });
  }

  function serveItem(
    type: "post" | "page",
    id: string,
    request: RecordedRequest,
  ): Response {
    const fields = (request.query.fields ?? "").split(",").map((f) => f.trim());
    if (fields.includes("tags") || fields.includes("authors")) {
      return errorBody(400, "BadRequestError", "Invalid fields");
    }
    const found = state.items.find(
      (i) =>
        i.id === id &&
        (i.type ?? "post") === type &&
        (i.status ?? "published") === "published",
    );
    if (!found) {
      return errorBody(
        404,
        "NotFoundError",
        `${type === "post" ? "Post" : "Page"} not found.`,
      );
    }
    const object = pick(
      request.query.fields,
      [...includeOf(request)],
      itemObject(found, includeOf(request)),
    );
    return json({ [type === "post" ? "posts" : "pages"]: [object] });
  }

  function serveTaxonomy(
    route: "tags" | "authors",
    request: RecordedRequest,
  ): Response {
    const source = route === "tags" ? state.tags : state.authors;
    let rows: { id: string }[] = [...source];
    const raw = request.query.filter;
    if (raw !== undefined && raw !== "") {
      const clause = parseFilter(raw);
      if (clause === null || clause.kind !== "ids") return badFilter();
      rows = rows.filter((r) => clause.ids.includes(r.id));
    }
    const objects = rows.map((r) =>
      route === "tags"
        ? tagObject(r as FakeTag)
        : authorObject(r as FakeAuthor),
    );
    const ordered = sorted(objects, request.query.order, "id asc");
    if (ordered === null) return badFilter();
    const { page, pagination } = paginate(ordered, request);
    return json({
      [route]: page.map((o) => pick(request.query.fields, [], o)),
      meta: { pagination },
    });
  }

  function serve(request: RecordedRequest): Response {
    if (options.notGhost === "html") {
      return new Response("<!doctype html><html><body>Hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (options.notGhost === "not-found") {
      return new Response("<html><body>Not found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.host !== siteHost) {
      return new Response("not found", { status: 404 });
    }
    if (request.method !== "GET") {
      return errorBody(405, "MethodNotAllowedError", "Method not allowed");
    }
    const path = request.path;
    if (path !== apiPrefix && !path.startsWith(`${apiPrefix}/`)) {
      return errorBody(404, "NotFoundError", "Resource not found");
    }
    const rest = path.slice(apiPrefix.length + 1);

    // The no-slash form redirects to the slash form, query included. The key
    // check comes after, as in Ghost's router.
    if (rest !== "" && !rest.endsWith("/")) {
      const search = new URL(request.url).search;
      return new Response(null, {
        status: 301,
        headers: {
          location: `${siteBase}${path.slice(basePath.length)}/${search}`,
        },
      });
    }

    const given = request.query.key;
    if (given === undefined || given === "") {
      return errorBody(403, "NoPermissionError", "Authorization failed");
    }
    if (given !== key) {
      return errorBody(
        403,
        "UnauthorizedError",
        "Unknown Content API Key",
        "UNKNOWN_CONTENT_API_KEY",
      );
    }

    const route = rest.slice(0, -1);
    if (route === "settings") {
      return json({ settings: state.settings, meta: {} });
    }
    switch (route) {
      case "posts":
        return serveItems("post", request);
      case "pages":
        return serveItems("page", request);
      case "tags":
        return serveTaxonomy("tags", request);
      case "authors":
        return serveTaxonomy("authors", request);
    }
    const single = /^(posts|pages)\/([0-9a-f]{24})$/.exec(route);
    if (single) {
      return serveItem(
        single[1] === "pages" ? "page" : "post",
        single[2] as string,
        request,
      );
    }
    return errorBody(404, "NotFoundError", "Resource not found");
  }

  const fake: FakeGhost = {
    fetch: (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const query: Record<string, string> = {};
      const queryAll: Record<string, string[]> = {};
      url.searchParams.forEach((value, name) => {
        query[name] = value;
        (queryAll[name] ??= []).push(value);
      });
      const request: RecordedRequest = {
        method: init?.method ?? "GET",
        url: url.toString(),
        host: url.host.toLowerCase(),
        path: url.pathname,
        query,
        queryAll,
        headers,
        initKeys: init ? Object.keys(init) : [],
        redirect: init?.redirect,
      };
      requests.push(request);

      hook?.(request, fake);

      const index = faults.findIndex((f) => !f.match || f.match(request));
      const pending = index === -1 ? undefined : faults[index];
      if (pending) {
        pending.left -= 1;
        if (pending.left <= 0) faults.splice(index, 1);
        const { fault } = pending;
        if ("networkError" in fault) throw new TypeError("fetch failed");
        if ("hang" in fault) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        const bodyless = [101, 204, 205, 304].includes(fault.status);
        return new Response(bodyless ? null : (fault.body ?? ""), {
          status: fault.status,
          headers: fault.headers,
        });
      }

      const response = serve(request);
      const mutation = mutations[0];
      if (!mutation) return response;
      mutation.left -= 1;
      if (mutation.left <= 0) mutations.shift();
      const merged = new Headers(response.headers);
      for (const [name, value] of Object.entries(mutation.headers)) {
        if (value === null) merged.delete(name);
        else merged.set(name, value);
      }
      return new Response(response.body, {
        status: response.status,
        headers: merged,
      });
    }) as typeof fetch,
    requests,
    state,
    setState(next) {
      Object.assign(state, next);
    },
    failNext(fault, times = 1, match) {
      faults.push({ fault, left: times, match });
    },
    rateLimitNext(seconds, times = 1) {
      faults.push({
        fault: {
          status: 429,
          headers: { "retry-after": String(seconds) },
          body: "",
        },
        left: times,
      });
    },
    redirectNext(location, times = 1, status = 302) {
      faults.push({
        fault: { status, headers: { location } },
        left: times,
      });
    },
    mutateNext(headers, times = 1) {
      mutations.push({ headers, left: times });
    },
    onBeforeRequest(next) {
      hook = next;
    },
  };
  return fake;
}

/** 24-hex id from a small number, e.g. `hexId(1)` is `"000000000000000000000001"`. */
export function hexId(n: number): string {
  return n.toString(16).padStart(24, "0");
}

/** Two published posts, one published page, one members-only post, two tags. */
export function sampleState(): {
  items: FakeItem[];
  tags: FakeTag[];
  authors: FakeAuthor[];
} {
  const tags: FakeTag[] = [
    { id: hexId(0x101), name: "News", slug: "news" },
    { id: hexId(0x102), name: "Guides", slug: "guides" },
  ];
  const authors: FakeAuthor[] = [{ id: hexId(0x201), name: "Ada" }];
  const items: FakeItem[] = [
    {
      id: hexId(1),
      type: "post",
      title: "First",
      tags: [tags[0]!.id],
      authors: [authors[0]!.id],
    },
    {
      id: hexId(2),
      type: "post",
      title: "Second",
      tags: [tags[0]!.id, tags[1]!.id],
      authors: [authors[0]!.id],
    },
    { id: hexId(3), type: "page", title: "About", authors: [authors[0]!.id] },
    {
      id: hexId(4),
      type: "post",
      title: "Members only",
      visibility: "members",
    },
  ];
  return { items, tags, authors };
}

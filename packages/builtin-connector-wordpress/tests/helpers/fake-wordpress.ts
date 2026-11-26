/**
 * An in-process fake of the WordPress REST API, exposed as a `fetch`. There are
 * no sockets: the fake is a function over `(url, init)` that records every
 * request and answers from a {@link FakeWordPress} state. It follows what a real
 * WordPress answers (verified against real sites on 2026-11-26):
 *
 * - the site home page (`GET <siteBase>/`) answers 200 and, depending on
 *   {@link FakeWordPressOptions.discovery}, carries a `Link:
 *   <...wp-json...>; rel="https://api.w.org/"` header and/or a
 *   `<link rel="https://api.w.org/" href="...">` tag in the HTML (alongside
 *   `rel="alternate"` and `rel="shortlink"` links, as a real site does);
 * - the REST root index answers `{ name, namespaces: [... "wp/v2" ...] }`
 *   (pretty `/wp-json/`, plain `?rest_route=/`, or the hosted
 *   `public-api.wordpress.com` form);
 * - list routes (`/wp/v2/posts`, `/pages`, `/categories`, `/tags`, `/users`,
 *   `/search`) carry `X-WP-Total` and `X-WP-TotalPages`, page by `per_page` and
 *   `page`, and filter by `status`, `categories` and `include`;
 * - unpublished statuses are served only with a valid Basic credential; an
 *   anonymous `status` filter for them answers 400 `rest_invalid_param` with
 *   `details.status.code = "rest_forbidden_status"`;
 * - `/users` can be hidden (401), posts can be password protected
 *   (`content.protected`), the whole REST surface can require login (401), and
 *   the root index can omit `wp/v2` (REST disabled).
 *
 * Faults (status overrides, network errors, hangs), header mutations and state
 * mutations are injected per request, in the style of `fake-discourse.ts`.
 */

export type FakeStatus = "publish" | "draft" | "private" | "future" | "pending";

export type FakePost = {
  id: number;
  type?: "post" | "page";
  status?: FakeStatus;
  title?: string;
  content?: string;
  /** Overrides the default citation link `<siteBase>/?p=<id>`. */
  link?: string;
  modified_gmt?: string;
  categories?: number[];
  tags?: number[];
  author?: number;
  /** `content.protected = true`, `content.rendered = ""` (a protected post). */
  protected?: boolean;
  slug?: string;
};

export type FakeCategory = {
  id: number;
  name: string;
  parent?: number;
  slug?: string;
};

export type FakeTag = { id: number; name: string; slug?: string };

export type FakeUser = { id: number; name: string };

export type FakeState = {
  categories: FakeCategory[];
  tags: FakeTag[];
  /** `null` hides `/users` (answers 401, as a locked-down site does). */
  users: FakeUser[] | null;
  posts: FakePost[];
};

export type RootStyle = "pretty" | "plain" | "wpcom";
export type DiscoveryMode = "header" | "tag" | "both" | "none";

export type FakeWordPressOptions = {
  /** The validated site base, e.g. `https://site.example` or `.../blog`. */
  siteBase: string;
  /** Which REST root the home page advertises; default `pretty`. */
  root?: RootStyle;
  /** Where the `api.w.org` link lives; default `header`. */
  discovery?: DiscoveryMode;
  /** Overrides the advertised root (for hostile or malformed-root tests). */
  advertisedRoot?: string;
  /** The index `name`; default `"Example"`. */
  name?: string | null;
  /** The index `namespaces`; default includes `wp/v2`. */
  namespaces?: string[];
  /** The index omits `wp/v2` (REST disabled). */
  restDisabled?: boolean;
  /** Every REST route answers 401 with a `rest_*` code (login-walled site). */
  loginRequired?: boolean;
  /** The Basic credential that unlocks unpublished content and `/users/me`. */
  credential?: { username: string; secret: string };
  categories?: FakeCategory[];
  tags?: FakeTag[];
  users?: FakeUser[] | null;
  posts?: FakePost[];
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

export type FakeWordPress = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** The root URL the home page advertises (header and/or tag). */
  advertisedRoot: string;
  setState(state: Partial<FakeState>): void;
  /** The next `times` requests (optionally only those matching) get `fault`. */
  failNext(
    fault: FakeFault,
    times?: number,
    match?: (request: RecordedRequest) => boolean,
  ): void;
  /** Set (string) or remove (null) response headers on the next `times` served responses. */
  mutateNext(headers: Record<string, string | null>, times?: number): void;
};

const WPCOM_HOST = "public-api.wordpress.com";
const DATE = "2026-01-01T00:00:00.000Z";

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

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function basePathOf(siteBase: string): string {
  const path = new URL(siteBase).pathname;
  return path === "/" ? "" : path.replace(/\/$/, "");
}

function advertisedRootFor(options: FakeWordPressOptions): string {
  if (options.advertisedRoot !== undefined) return options.advertisedRoot;
  const siteBase = options.siteBase.replace(/\/$/, "");
  const host = new URL(siteBase).host;
  switch (options.root ?? "pretty") {
    case "pretty":
      return `${siteBase}/wp-json/`;
    case "plain":
      return `${siteBase}/?rest_route=/`;
    case "wpcom":
      return `https://${WPCOM_HOST}/wp-json/?rest_route=/sites/${host}`;
  }
}

function expectedAuth(
  credential: { username: string; secret: string } | undefined,
): string | null {
  if (!credential) return null;
  const token = Buffer.from(
    `${credential.username}:${credential.secret}`,
    "utf8",
  ).toString("base64");
  return `Basic ${token}`;
}

export function createFakeWordPress(
  options: FakeWordPressOptions,
): FakeWordPress {
  const siteBase = options.siteBase.replace(/\/$/, "");
  const siteUrl = new URL(siteBase);
  const siteHost = siteUrl.host.toLowerCase();
  const basePath = basePathOf(siteBase);
  const root: RootStyle = options.root ?? "pretty";
  const discovery: DiscoveryMode = options.discovery ?? "header";
  const advertisedRoot = advertisedRootFor(options);
  const name = options.name === undefined ? "Example" : options.name;
  const namespaces = options.namespaces ?? [
    "oembed/1.0",
    "wp/v2",
    "wp-site-health/v1",
  ];
  const auth = expectedAuth(options.credential);

  const state: FakeState = {
    categories: options.categories ?? [],
    tags: options.tags ?? [],
    users: options.users === undefined ? [] : options.users,
    posts: options.posts ?? [],
  };

  const requests: RecordedRequest[] = [];
  const faults: {
    fault: FakeFault;
    left: number;
    match?: (request: RecordedRequest) => boolean;
  }[] = [];
  const mutations: { headers: Record<string, string | null>; left: number }[] =
    [];

  function hasValidAuth(request: RecordedRequest): boolean {
    return auth !== null && request.headers.authorization === auth;
  }

  function indexBody(): Response {
    const ns = options.restDisabled
      ? namespaces.filter((n) => n !== "wp/v2")
      : namespaces;
    return json({ name, description: "", url: siteBase, namespaces: ns });
  }

  function homeResponse(): Response {
    const extra = [
      `<${siteBase}/feed/>; rel="alternate"; type="application/rss+xml"`,
      `<${siteBase}/>; rel="shortlink"`,
    ];
    const headers: Record<string, string> = {};
    const apiLink = `<${advertisedRoot}>; rel="https://api.w.org/"`;
    if (discovery === "header" || discovery === "both") {
      headers.Link = [apiLink, ...extra].join(", ");
    } else {
      headers.Link = extra.join(", ");
    }
    const tags =
      discovery === "tag" || discovery === "both"
        ? `<link rel="alternate" href="${siteBase}/feed/">` +
          `<link href="${advertisedRoot}" rel="https://api.w.org/">`
        : `<link rel="alternate" href="${siteBase}/feed/">`;
    const body = `<!doctype html><html><head><title>Example</title>${tags}</head><body><h1>Example</h1></body></html>`;
    return html(body, headers);
  }

  function post(p: FakePost): Record<string, unknown> {
    const type = p.type ?? "post";
    const link = p.link ?? `${siteBase}/?p=${p.id}`;
    return {
      id: p.id,
      type,
      status: p.status ?? "publish",
      slug: p.slug ?? `item-${p.id}`,
      link,
      modified_gmt: p.modified_gmt ?? DATE,
      date_gmt: p.modified_gmt ?? DATE,
      title: { rendered: p.title ?? `Item ${p.id}` },
      content: {
        rendered: p.protected ? "" : (p.content ?? `<p>Body ${p.id}</p>`),
        protected: p.protected ?? false,
      },
      categories: p.categories ?? [],
      tags: p.tags ?? [],
      author: p.author ?? 1,
    };
  }

  function listHeaders(total: number, perPage: number): Record<string, string> {
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
    return {
      "X-WP-Total": String(total),
      "X-WP-TotalPages": String(totalPages),
    };
  }

  function paginate<T>(
    items: T[],
    request: RecordedRequest,
  ): { page: T[]; total: number; perPage: number } {
    const perPage = Math.min(100, Number(request.query.per_page ?? "10") || 10);
    const pageNo = Math.max(1, Number(request.query.page ?? "1") || 1);
    const start = (pageNo - 1) * perPage;
    return {
      page: items.slice(start, start + perPage),
      total: items.length,
      perPage,
    };
  }

  function wantedStatuses(request: RecordedRequest): FakeStatus[] {
    const raw = request.query.status;
    if (raw === undefined || raw === "") return ["publish"];
    return raw.split(",").map((s) => s.trim()) as FakeStatus[];
  }

  function restForbiddenStatus(): Response {
    return json(
      {
        code: "rest_invalid_param",
        message: "Invalid parameter(s): status",
        data: {
          status: 400,
          params: { status: "Status is forbidden." },
          details: { status: { code: "rest_forbidden_status" } },
        },
      },
      400,
    );
  }

  function servePosts(
    type: "post" | "page",
    request: RecordedRequest,
  ): Response {
    const statuses = wantedStatuses(request);
    const unpublished = statuses.some((s) => s !== "publish");
    if (unpublished && !hasValidAuth(request)) return restForbiddenStatus();
    let items = state.posts.filter(
      (p) =>
        (p.type ?? "post") === type && statuses.includes(p.status ?? "publish"),
    );
    const cats = request.query.categories;
    if (cats !== undefined && cats !== "") {
      const wanted = new Set(cats.split(",").map((n) => Number(n)));
      items = items.filter((p) =>
        (p.categories ?? []).some((c) => wanted.has(c)),
      );
    }
    const include = request.query.include;
    if (include !== undefined && include !== "") {
      const wanted = new Set(include.split(",").map((n) => Number(n)));
      items = items.filter((p) => wanted.has(p.id));
    }
    items = [...items].sort((a, b) => a.id - b.id);
    const { page, total, perPage } = paginate(items, request);
    return json(page.map(post), 200, listHeaders(total, perPage));
  }

  function serveSingle(
    type: "post" | "page",
    id: number,
    request: RecordedRequest,
  ): Response {
    const found = state.posts.find(
      (p) => p.id === id && (p.type ?? "post") === type,
    );
    if (!found) return json({ code: "rest_post_invalid_id" }, 404);
    const status = found.status ?? "publish";
    if (status !== "publish" && !hasValidAuth(request)) {
      return json({ code: "rest_forbidden" }, 401);
    }
    return json(post(found));
  }

  function serveCategories(request: RecordedRequest): Response {
    const items = [...state.categories].sort((a, b) => a.id - b.id);
    const { page, total, perPage } = paginate(items, request);
    return json(
      page.map((c) => ({
        id: c.id,
        name: c.name,
        parent: c.parent ?? 0,
        slug: c.slug ?? `cat-${c.id}`,
      })),
      200,
      listHeaders(total, perPage),
    );
  }

  function serveTags(request: RecordedRequest): Response {
    let items = [...state.tags].sort((a, b) => a.id - b.id);
    const include = request.query.include;
    if (include !== undefined && include !== "") {
      const wanted = new Set(include.split(",").map((n) => Number(n)));
      items = items.filter((t) => wanted.has(t.id));
    }
    const { page, total, perPage } = paginate(items, request);
    return json(
      page.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug ?? `tag-${t.id}`,
      })),
      200,
      listHeaders(total, perPage),
    );
  }

  function serveUsers(request: RecordedRequest): Response {
    if (state.users === null)
      return json({ code: "rest_user_cannot_view" }, 401);
    let items = [...state.users].sort((a, b) => a.id - b.id);
    const include = request.query.include;
    if (include !== undefined && include !== "") {
      const wanted = new Set(include.split(",").map((n) => Number(n)));
      items = items.filter((u) => wanted.has(u.id));
    }
    const { page, total, perPage } = paginate(items, request);
    return json(
      page.map((u) => ({ id: u.id, name: u.name })),
      200,
      listHeaders(total, perPage),
    );
  }

  function serveSearch(request: RecordedRequest): Response {
    const q = (request.query.search ?? "").toLowerCase();
    const items = state.posts
      .filter((p) => (p.title ?? `Item ${p.id}`).toLowerCase().includes(q))
      .filter((p) => (p.status ?? "publish") === "publish")
      .sort((a, b) => a.id - b.id);
    const { page, total, perPage } = paginate(items, request);
    return json(
      page.map((p) => ({
        id: p.id,
        title: p.title ?? `Item ${p.id}`,
        url: p.link ?? `${siteBase}/?p=${p.id}`,
        type: p.type ?? "post",
        subtype: p.type ?? "post",
      })),
      200,
      listHeaders(total, perPage),
    );
  }

  /** Reduce a request URL to a logical REST route, independent of root style. */
  function logical(
    request: RecordedRequest,
  ):
    | { kind: "home" }
    | { kind: "index" }
    | { kind: "route"; route: string }
    | { kind: "miss" } {
    const url = new URL(request.url);
    const host = url.host.toLowerCase();
    const restRoute = request.query.rest_route;

    if (root === "wpcom") {
      if (host === siteHost) {
        if (url.pathname === `${basePath}/` && restRoute === undefined) {
          return { kind: "home" };
        }
        return { kind: "miss" };
      }
      if (host === WPCOM_HOST) {
        if (
          url.pathname === "/wp-json/" &&
          restRoute === `/sites/${siteHost}`
        ) {
          return { kind: "index" };
        }
        const prefix = `/wp/v2/sites/${siteHost}`;
        if (url.pathname.startsWith(`${prefix}/`)) {
          return {
            kind: "route",
            route: `/wp/v2${url.pathname.slice(prefix.length)}`,
          };
        }
        return { kind: "miss" };
      }
      return { kind: "miss" };
    }

    if (host !== siteHost) return { kind: "miss" };

    if (root === "plain") {
      if (restRoute === undefined) {
        if (url.pathname === `${basePath}/`) return { kind: "home" };
        return { kind: "miss" };
      }
      if (restRoute === "/") return { kind: "index" };
      if (restRoute.startsWith("/wp/v2/")) {
        return { kind: "route", route: restRoute };
      }
      return { kind: "miss" };
    }

    // pretty
    if (url.pathname === `${basePath}/` && restRoute === undefined) {
      return { kind: "home" };
    }
    const wpJson = `${basePath}/wp-json`;
    if (url.pathname === `${wpJson}/` || url.pathname === wpJson) {
      return { kind: "index" };
    }
    if (url.pathname.startsWith(`${wpJson}/wp/v2/`)) {
      return { kind: "route", route: url.pathname.slice(wpJson.length) };
    }
    return { kind: "miss" };
  }

  function serve(request: RecordedRequest): Response {
    if (request.method !== "GET") return json({ code: "rest_no_route" }, 404);
    const target = logical(request);

    if (target.kind === "home") return homeResponse();
    if (target.kind === "index") return indexBody();
    if (target.kind === "miss") return json({ code: "rest_no_route" }, 404);

    if (options.loginRequired) {
      return json({ code: "rest_not_logged_in" }, 401);
    }

    const route = target.route;
    const single = /^\/wp\/v2\/(posts|pages)\/([0-9]+)$/.exec(route);
    if (single) {
      return serveSingle(
        single[1] === "pages" ? "page" : "post",
        Number(single[2]),
        request,
      );
    }
    switch (route) {
      case "/wp/v2/posts":
        return servePosts("post", request);
      case "/wp/v2/pages":
        return servePosts("page", request);
      case "/wp/v2/categories":
        return serveCategories(request);
      case "/wp/v2/tags":
        return serveTags(request);
      case "/wp/v2/users":
        return serveUsers(request);
      case "/wp/v2/search":
        return serveSearch(request);
      default:
        return json({ code: "rest_no_route" }, 404);
    }
  }

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const query: Record<string, string> = {};
    const queryAll: Record<string, string[]> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
      (queryAll[key] ??= []).push(value);
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
    for (const [key, value] of Object.entries(mutation.headers)) {
      if (value === null) merged.delete(key);
      else merged.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: merged,
    });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    advertisedRoot,
    setState(next) {
      Object.assign(state, next);
    },
    failNext(fault, times = 1, match) {
      faults.push({ fault, left: times, match });
    },
    mutateNext(headers, times = 1) {
      mutations.push({ headers, left: times });
    },
  };
}

/** A small site with two categories, a tag, a user, and two published posts. */
export function samplePosts(): FakePost[] {
  return [
    {
      id: 1,
      type: "post",
      title: "First",
      categories: [10],
      tags: [20],
      author: 5,
    },
    {
      id: 2,
      type: "post",
      title: "Second",
      categories: [11],
      tags: [20],
      author: 5,
    },
    { id: 3, type: "page", title: "About", author: 5 },
  ];
}

import { WordPressError } from "./errors";
import { HOME_HTML_BYTES, WORDPRESS_USER_AGENT } from "./limits";
import {
  abortable,
  createTransport,
  discard,
  type ClientLimits,
  type Transport,
} from "./transport";

/**
 * A validated REST root. `pretty` is a `.../wp-json` base; `plain` is a
 * `...?rest_route=/` index URL; `wpcom` is the hosted `public-api.wordpress.com`
 * form, where `base` is `.../wp/v2/sites/<host>` and `host` is the site host.
 */
export type RestRoot =
  | { kind: "pretty"; base: string }
  | { kind: "plain"; index: string }
  | { kind: "wpcom"; base: string; host: string };

const WPCOM_ORIGIN = "https://public-api.wordpress.com";
const API_REL = "https://api.w.org/";

export type DiscoverRestRootInput = {
  /** The host fetch scope: it owns the address policy. */
  fetch: typeof fetch;
  /** A base as {@link import("./site-url").parseSiteUrl} returns it. */
  siteBase: string;
  /** Only the public adapter accepts the hosted wordpress.com route. */
  allowWpcom: boolean;
  signal?: AbortSignal;
  /** Test seams, mirroring the client. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  limits?: Partial<ClientLimits>;
};

/** Reads at most `maxBytes` bytes of the home page and stops; the tag must be
 * within the cap or it is not seen. Never throws on a large body — it truncates. */
async function readUpTo(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already done with the stream.
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.byteLength, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * The first `<uri>` in a `Link` header whose `rel` lists `https://api.w.org/`.
 * A combined header carries several comma-separated values; a `rel` may be
 * quoted and may list several space-separated relation types.
 */
function apiLinkFromHeader(value: string | null): string | null {
  if (value === null) return null;
  const re = /<([^>]*)>([^<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const uri = (match[1] ?? "").trim();
    const params = match[2] ?? "";
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]+))/i.exec(
      params,
    );
    if (rel === null) continue;
    const types = (rel[1] ?? rel[2] ?? rel[3] ?? "").trim().split(/\s+/);
    if (types.includes(API_REL)) return uri;
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s">]+))`,
    "i",
  );
  const match = re.exec(tag);
  if (match === null) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** The `href` of the first `<link rel="...https://api.w.org/...">` tag.
 * HTML comments are stripped first, so a commented-out tag is never used. */
function apiLinkFromHtml(html: string): string | null {
  // A comment runs to its close or, when the read was truncated mid-comment,
  // to the end of the window; either way nothing inside it is a live tag.
  const live = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  const re = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(live)) !== null) {
    const rel = attribute(match[0], "rel");
    if (rel === null) continue;
    if (!rel.split(/\s+/).includes(API_REL)) continue;
    const href = attribute(match[0], "href");
    if (href !== null && href !== "") return href;
  }
  return null;
}

/**
 * Classifies a candidate root against the site. Accepts only: the site's own
 * origin as a pretty `.../wp-json` base or a plain `...?rest_route=/` index; or,
 * when `allowWpcom`, the hosted `public-api.wordpress.com/wp-json/?rest_route=/sites/<host>`
 * for the site host. Anything else (another origin, port, scheme, userinfo, a
 * different host, a wrong same-origin path) is `null`.
 */
function classifyRoot(
  rootUrl: string,
  siteOrigin: string,
  siteBasePath: string,
  siteHost: string,
  allowWpcom: boolean,
): RestRoot | null {
  let url: URL;
  try {
    url = new URL(rootUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;

  if (url.origin === siteOrigin) {
    const pathNoSlash = url.pathname.replace(/\/$/, "");
    const restRoute = url.searchParams.get("rest_route");
    if (
      restRoute === "/" &&
      url.searchParams.size === 1 &&
      (pathNoSlash === siteBasePath ||
        pathNoSlash === `${siteBasePath}/index.php`)
    ) {
      return {
        kind: "plain",
        index: `${siteOrigin}${url.pathname}?rest_route=/`,
      };
    }
    if (url.search === "" && pathNoSlash === `${siteBasePath}/wp-json`) {
      return { kind: "pretty", base: `${siteOrigin}${siteBasePath}/wp-json` };
    }
    return null;
  }

  if (allowWpcom && url.origin === WPCOM_ORIGIN) {
    const restRoute = url.searchParams.get("rest_route");
    if (url.pathname === "/wp-json/" && restRoute === `/sites/${siteHost}`) {
      return {
        kind: "wpcom",
        base: `${WPCOM_ORIGIN}/wp/v2/sites/${siteHost}`,
        host: siteHost,
      };
    }
    return null;
  }

  return null;
}

/**
 * Discovers a site's REST root over a {@link Transport} (spec "REST root
 * discovery", steps 1–3): fetch the home page with `redirect: "manual"`, read
 * the `api.w.org` link from a `Link` header (the header wins) or the first
 * `<link>` tag in the first {@link HOME_HTML_BYTES} of HTML, and validate the
 * candidate root. A redirect is `BLOCKED_ENDPOINT`; a non-conforming root is
 * `BLOCKED_ENDPOINT`; a missing link is `NOT_A_WORDPRESS_SITE`. The `wp/v2`
 * namespace check (step 4) is the client's `getIndex`, not this function.
 *
 * The client calls this with its own transport, so a discovery request counts
 * toward the same budget and gap as the client's REST reads.
 */
export async function discoverWith(
  transport: Transport,
  params: { siteBase: string; allowWpcom: boolean },
): Promise<RestRoot> {
  const site = new URL(params.siteBase);
  const siteOrigin = site.origin;
  const siteHost = site.host.toLowerCase();
  const siteBasePath =
    site.pathname === "/" ? "" : site.pathname.replace(/\/$/, "");
  const url = `${siteOrigin}${siteBasePath}/`;

  return transport.request(
    url,
    {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": WORDPRESS_USER_AGENT,
    },
    async (response, signal) => {
      const { status } = response;
      if (status === 200) {
        let rootUrl = apiLinkFromHeader(response.headers.get("link"));
        if (rootUrl === null) {
          const bytes = await readUpTo(response, HOME_HTML_BYTES, signal);
          rootUrl = apiLinkFromHtml(new TextDecoder("utf-8").decode(bytes));
        } else {
          await discard(response);
        }
        if (rootUrl === null) {
          throw new WordPressError("NOT_A_WORDPRESS_SITE");
        }
        const root = classifyRoot(
          rootUrl,
          siteOrigin,
          siteBasePath,
          siteHost,
          params.allowWpcom,
        );
        if (root === null) throw new WordPressError("BLOCKED_ENDPOINT");
        return root;
      }
      await discard(response);
      if (status >= 500) throw new WordPressError("SITE_UNREACHABLE");
      throw new WordPressError("NOT_A_WORDPRESS_SITE");
    },
  );
}

/**
 * Discovers a site's REST root with a fresh transport over `input.fetch`. The
 * signature takes a raw `fetch` so it is independently testable; the client
 * uses {@link discoverWith} with its own transport.
 */
export async function discoverRestRoot(
  input: DiscoverRestRootInput,
): Promise<RestRoot> {
  const transport = createTransport({
    fetch: input.fetch,
    now: input.now,
    sleep: input.sleep,
    signal: input.signal,
    requestTimeoutMs: input.requestTimeoutMs,
    limits: input.limits,
  });
  return discoverWith(transport, {
    siteBase: input.siteBase,
    allowWpcom: input.allowWpcom,
  });
}

// `/wp/v2/<resource>` or `/wp/v2/<resource>/<id>`; `/wp/v2/users/me` is the one
// allowed non-numeric tail (login readiness reads the current user). Anything
// with `..`, `?`, `#`, `%`, uppercase or an extra segment is refused.
const ROUTE = /^\/wp\/v2\/[a-z]+(?:\/[0-9]+)?$/;
const USERS_ME = "/wp/v2/users/me";

function isAllowedRoute(route: string): boolean {
  return route === USERS_ME || ROUTE.test(route);
}

function queryString(
  params: Record<string, string | number> | undefined,
  separator: "?" | "&",
): string {
  if (params === undefined) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `${separator}${rendered}`;
}

/**
 * Builds a request URL for a fixed `/wp/v2/...` route under a discovered root.
 * For a `plain` root the route goes into `rest_route` (slashes preserved) and
 * params follow it; for a `wpcom` root the `/wp/v2` prefix is dropped because
 * the base already carries it. A route outside the allow-list is `CONFIG_INVALID`.
 */
export function routeUrl(
  root: RestRoot,
  route: string,
  params?: Record<string, string | number>,
): string {
  if (!isAllowedRoute(route)) throw new WordPressError("CONFIG_INVALID");
  switch (root.kind) {
    case "pretty":
      return `${root.base}${route}${queryString(params, "?")}`;
    case "plain": {
      const prefix = root.index.split("?")[0] as string;
      const encoded = route.split("/").map(encodeURIComponent).join("/");
      return `${prefix}?rest_route=${encoded}${queryString(params, "&")}`;
    }
    case "wpcom": {
      const stripped = route.slice("/wp/v2".length);
      return `${root.base}${stripped}${queryString(params, "?")}`;
    }
  }
}

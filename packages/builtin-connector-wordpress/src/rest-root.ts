import type { ClientLimits } from "./client";
import { WordPressError } from "./errors";
import {
  HOME_HTML_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  WORDPRESS_USER_AGENT,
} from "./limits";

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

class Timeout {}

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

function retryAfterMs(
  response: Response,
  attempt: number,
  now: () => number,
  maxDelay: number,
): number {
  const backoff = Math.min(500 * (attempt + 1), maxDelay);
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return backoff;
  if (/^\d{1,9}$/.test(header))
    return Math.min(Number(header) * 1000, maxDelay);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now()), maxDelay);
  return backoff;
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

/** The `href` of the first `<link rel="...https://api.w.org/...">` tag. */
function apiLinkFromHtml(html: string): string | null {
  const re = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
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
 * Discovers a site's REST root (spec "REST root discovery", steps 1–3): fetch
 * the home page with `redirect: "manual"`, read the `api.w.org` link from a
 * `Link` header (the header wins) or the first `<link>` tag in the first
 * {@link HOME_HTML_BYTES} of HTML, and validate the candidate root. A redirect
 * is `BLOCKED_ENDPOINT` and is never followed; a non-conforming root is
 * `BLOCKED_ENDPOINT`; a missing link is `NOT_A_WORDPRESS_SITE`. The `wp/v2`
 * namespace check (step 4) is the client's `getIndex`, not this function.
 */
export async function discoverRestRoot(
  input: DiscoverRestRootInput,
): Promise<RestRoot> {
  const site = new URL(input.siteBase);
  const siteOrigin = site.origin;
  const siteHost = site.host.toLowerCase();
  const siteBasePath =
    site.pathname === "/" ? "" : site.pathname.replace(/\/$/, "");
  const url = `${siteOrigin}${siteBasePath}/`;

  const now = input.now ?? Date.now;
  const external = input.signal;
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = input.limits?.maxRetries ?? MAX_RETRIES;
  const maxRetryDelayMs = input.limits?.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;

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

  let attempt = 0;
  for (;;) {
    if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new Timeout()), timeoutMs);
    const onExternalAbort = () => controller.abort(new Timeout());
    external?.addEventListener("abort", onExternalAbort, { once: true });

    let retry = false;
    let waitMs = Math.min(500 * (attempt + 1), maxRetryDelayMs);
    let rateLimited = false;
    try {
      const response = await abortable(
        input.fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": WORDPRESS_USER_AGENT,
          },
          redirect: "manual",
          signal,
        }),
        signal,
      );
      const { status } = response;
      if (status >= 300 && status < 400) {
        await discard(response);
        throw new WordPressError("BLOCKED_ENDPOINT");
      }
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
          input.allowWpcom,
        );
        if (root === null) throw new WordPressError("BLOCKED_ENDPOINT");
        return root;
      }
      if (status === 429 || (status >= 500 && status <= 599)) {
        rateLimited = status === 429;
        if (status === 429) {
          waitMs = retryAfterMs(response, attempt, now, maxRetryDelayMs);
        }
        await discard(response);
        if (attempt >= maxRetries) {
          throw new WordPressError(
            rateLimited ? "RATE_LIMITED" : "SITE_UNREACHABLE",
          );
        }
        retry = true;
      } else {
        await discard(response);
        throw new WordPressError("NOT_A_WORDPRESS_SITE");
      }
    } catch (error) {
      if (error instanceof WordPressError) throw error;
      if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
      if (attempt >= maxRetries) throw new WordPressError("SITE_UNREACHABLE");
      retry = true;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
    if (retry) {
      await wait(waitMs);
      attempt += 1;
    }
  }
}

const ROUTE = /^\/wp\/v2\/[a-z]+(?:\/[0-9]+)?$/;

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
 * the base already carries it. A route outside `/wp/v2` is `CONFIG_INVALID`.
 */
export function routeUrl(
  root: RestRoot,
  route: string,
  params?: Record<string, string | number>,
): string {
  if (!ROUTE.test(route)) throw new WordPressError("CONFIG_INVALID");
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

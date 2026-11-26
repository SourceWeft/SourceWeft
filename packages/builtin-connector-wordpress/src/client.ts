import { WordPressError, type WordPressErrorCode } from "./errors";
import {
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  REQUEST_TIMEOUT_MS,
  WORDPRESS_USER_AGENT,
} from "./limits";
import { discoverRestRoot, routeUrl, type RestRoot } from "./rest-root";
import { parseSiteUrl, siteHostOf } from "./site-url";

/** Limits a test may lower; production uses the constants in `limits.ts`. */
export type ClientLimits = {
  maxRequests: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  minRequestGapMs: number;
};

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
  /** Requests this client has issued (discovery is counted separately). */
  requestCount(): number;
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

/** Error bodies (401/403/404) are read only for a REST `code`; this is plenty. */
const ERROR_BODY_BYTES = 65_536;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** The REST error `code` of a JSON body, if it is an object with one. */
function errorCode(bytes: Uint8Array): string | null {
  try {
    const body: unknown = JSON.parse(decode(bytes));
    return isRecord(body) && typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** Maps a 401/403 to a login prompt or a credential failure (spec "Errors"). */
function authError(
  status: number,
  code: string | null,
  credentialed: boolean,
): WordPressErrorCode {
  if (credentialed) {
    if (code === "incorrect_password" || code === "invalid_username") {
      return "BAD_CREDENTIALS";
    }
    const isRestCode = code !== null && code.startsWith("rest_");
    if (status === 401 && !isRestCode) return "BAD_CREDENTIALS";
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
 * credential never leaves the site. Every failure is a {@link WordPressError}
 * with a fixed message: the site address, the credential and the body are never
 * forwarded, and no `cause` is set.
 */
export function createWordPressClient(
  input: CreateWordPressClientInput,
): WordPressClient {
  const siteBase = parseSiteUrl(input.siteBase);
  const siteOrigin = `https://${siteHostOf(siteBase)}`;
  const now = input.now ?? Date.now;
  const external = input.signal;
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const limits: ClientLimits = {
    maxRequests: MAX_REQUESTS,
    maxRetries: MAX_RETRIES,
    maxRetryDelayMs: MAX_RETRY_DELAY_MS,
    minRequestGapMs: MIN_REQUEST_GAP_MS,
    ...input.limits,
  };

  let requestCount = 0;
  let lastRequestAt: number | null = null;
  let rootPromise: Promise<RestRoot> | null = null;

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

  /** One logical GET: counts against the budget, spaces by the minimum gap,
   * retries 429/5xx/network, refuses a 3xx, and returns the final response for
   * the caller to map. A 200 or a 4xx is returned; a persistent 429 throws
   * RATE_LIMITED; network or timeout throws SITE_UNREACHABLE. */
  async function perform(
    url: string,
    authorization: string | undefined,
  ): Promise<RawResponse> {
    let attempt = 0;
    for (;;) {
      if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
      if (requestCount >= limits.maxRequests) {
        throw new WordPressError("TOO_LARGE");
      }
      requestCount += 1;
      if (lastRequestAt !== null) {
        const elapsed = now() - lastRequestAt;
        if (elapsed < limits.minRequestGapMs) {
          await wait(limits.minRequestGapMs - elapsed);
          if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
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
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": WORDPRESS_USER_AGENT,
        };
        if (authorization !== undefined) headers.Authorization = authorization;
        const response = await abortable(
          input.fetch(url, {
            method: "GET",
            headers,
            // The host scope follows a cross-origin redirect unless told not to.
            // `manual` hands any 3xx back, which is refused below: a credential
            // never follows a redirect and no endpoint is reached indirectly.
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
          const bytes = await readCapped(response, maxBytes, signal);
          return { status, headers: response.headers, bytes };
        }
        if (status === 429 || (status >= 500 && status <= 599)) {
          if (status === 429) {
            waitMs = retryAfterMs(
              response,
              attempt,
              now,
              limits.maxRetryDelayMs,
            );
          }
          await discard(response);
          if (attempt >= limits.maxRetries) {
            if (status === 429) throw new WordPressError("RATE_LIMITED");
            return {
              status,
              headers: response.headers,
              bytes: new Uint8Array(0),
            };
          }
          retry = true;
        } else {
          const bytes = await readCapped(
            response,
            Math.min(maxBytes, ERROR_BODY_BYTES),
            signal,
          );
          return { status, headers: response.headers, bytes };
        }
      } catch (error) {
        if (error instanceof WordPressError) throw error;
        if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
        if (attempt >= limits.maxRetries) {
          throw new WordPressError("SITE_UNREACHABLE");
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
    return (rootPromise ??= discoverRestRoot({
      fetch: input.fetch,
      siteBase,
      allowWpcom: input.allowWpcom,
      signal: input.signal,
      now: input.now,
      sleep: input.sleep,
      requestTimeoutMs: input.requestTimeoutMs,
      limits: input.limits,
    }));
  }

  return {
    discover,

    async getIndex() {
      const root = await discover();
      const url = indexUrl(root);
      const authorization = authorizationFor(url);
      const { status, headers, bytes } = await perform(url, authorization);
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
      if (status === 401 || status === 403) {
        throw new WordPressError(
          authError(status, errorCode(bytes), authorization !== undefined),
        );
      }
      if (status === 404) throw new WordPressError("NOT_A_WORDPRESS_SITE");
      throw new WordPressError("BAD_RESPONSE");
    },

    async getJson(route, params) {
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
      if (status === 401 || status === 403) {
        throw new WordPressError(
          authError(status, errorCode(bytes), authorization !== undefined),
        );
      }
      throw new WordPressError("BAD_RESPONSE");
    },

    requestCount() {
      return requestCount;
    },
  };
}

import {
  asWordPressRestCode,
  WordPressError,
  type WordPressErrorCode,
  type WordPressRestCode,
} from "./errors";
import { MAX_RESPONSE_BYTES, WORDPRESS_USER_AGENT } from "./limits";
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

  return {
    discover,

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
    },

    requestCount() {
      return transport.requestCount();
    },
  };
}

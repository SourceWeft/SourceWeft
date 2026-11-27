import { GhostError } from "./errors";
import {
  GHOST_USER_AGENT,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  REQUEST_TIMEOUT_MS,
} from "./limits";
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

/** `posts`, `settings`, or `posts/<24 hex id>`: nothing else is ever requested. */
const ROUTE = /^[a-z]+(?:\/[0-9a-f]{24})?$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Longest key accepted; real keys are 26 characters. */
const MAX_KEY_LENGTH = 256;
/** Error bodies are read only for a Ghost error `code`; this is plenty. */
const ERROR_BODY_BYTES = 65_536;

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

  return {
    getJson,
    requestCount: () => requestCount,
  };
}

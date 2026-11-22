import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { RssAdapterError } from "./errors";
import { parseFeedUrl } from "./feed-url";
import {
  FEED_MAX_BODY_BYTES,
  FEED_TIMEOUT_MS,
  FEED_USER_AGENT,
} from "./limits";

export type { FeedFetchFailure } from "./errors";
export { RssAdapterError } from "./errors";

export type FeedFetchResult =
  | { kind: "not_modified" }
  | {
      kind: "feed";
      body: string;
      etag: string | null;
      lastModified: string | null;
    };

const ACCEPT =
  "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

/** The host's policy error is duck-typed: this package cannot import backend code. */
function isEndpointNotAllowed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const direct = (error as { code?: unknown }).code;
  if (direct === "ENDPOINT_NOT_ALLOWED") return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED"
  );
}

function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Maps any failure to a fixed-message error; nothing from `error` is kept. */
function toFetchError(error: unknown, signal: AbortSignal): RssAdapterError {
  if (error instanceof RssAdapterError) return error;
  if (isEndpointNotAllowed(error)) {
    return new RssAdapterError("feed_blocked_address");
  }
  if (signal.aborted || isAbort(error)) {
    return new RssAdapterError("feed_timeout");
  }
  return new RssAdapterError("feed_unreachable");
}

/** Rejects when the signal aborts, so a fetch or read that ignores it cannot hang. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new RssAdapterError("feed_timeout"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RssAdapterError("feed_timeout"));
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

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failed cancel changes nothing.
  }
}

/**
 * Reads at most `maxBytes` decompressed bytes. The stream is cancelled the
 * moment one byte more arrives, so a hostile body is never fully read: the
 * parser's own work is bounded by this ceiling.
 */
async function readCapped(
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
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RssAdapterError("feed_too_large");
      }
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

function declaredLengthExceeds(response: Response, maxBytes: number): boolean {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return false;
  return Number(raw.trim()) > maxBytes;
}

/**
 * Fetches a feed document through the host's public-internet-only fetch.
 * Every call opens its own scope (a denied scope stays poisoned) and closes it
 * on every path. Errors carry fixed messages only: the URL, which may hold a
 * token, and the underlying error text are never forwarded.
 */
export async function fetchFeed(input: {
  publicFetch: () => ConnectorPublicFetchScope;
  feedUrl: string;
  validators?: { etag?: string | null; lastModified?: string | null };
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<FeedFetchResult> {
  const parsed = parseFeedUrl(input.feedUrl);
  if (!parsed.ok) throw new RssAdapterError(parsed.reason);

  const timeoutMs = input.timeoutMs ?? FEED_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? FEED_MAX_BODY_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);

  const headers: Record<string, string> = {
    "User-Agent": FEED_USER_AGENT,
    Accept: ACCEPT,
  };
  const etag = input.validators?.etag;
  const lastModified = input.validators?.lastModified;
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  let scope: ConnectorPublicFetchScope;
  try {
    scope = input.publicFetch();
  } catch {
    throw new RssAdapterError("feed_unreachable");
  }
  try {
    const response = await abortable(
      scope.fetch(parsed.url.toString(), { method: "GET", headers, signal }),
      signal,
    );
    if (response.status === 304) {
      await discardBody(response);
      return { kind: "not_modified" };
    }
    if (response.status < 200 || response.status > 299) {
      await discardBody(response);
      throw new RssAdapterError("feed_http_error");
    }
    if (declaredLengthExceeds(response, maxBytes)) {
      await discardBody(response);
      throw new RssAdapterError("feed_too_large");
    }
    const bytes = await readCapped(response, maxBytes, signal);
    return {
      kind: "feed",
      body: new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } catch (error) {
    throw toFetchError(error, signal);
  } finally {
    try {
      await scope.close();
    } catch {
      // A failed close must not replace the feed result or the mapped error.
    }
  }
}

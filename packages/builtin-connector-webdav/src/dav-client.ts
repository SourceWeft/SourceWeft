import { WebDavError } from "./errors";
import {
  MAX_MULTISTATUS_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  WEBDAV_USER_AGENT,
} from "./limits";
import { parseMultistatus, type DavEntry } from "./multistatus";
import { toRequestUrl } from "./paths";

export type { DavEntry } from "./multistatus";

/** The only methods this connector can send. The type makes anything else a
 * compile error; {@link assertReadOnlyMethod} enforces it at run time. */
export type DavMethod = "PROPFIND" | "GET" | "OPTIONS";

const READ_ONLY_METHODS: ReadonlySet<string> = new Set<DavMethod>([
  "PROPFIND",
  "GET",
  "OPTIONS",
]);

/** Throws unless `method` is PROPFIND, GET or OPTIONS (exact, upper case). */
export function assertReadOnlyMethod(
  method: string,
): asserts method is DavMethod {
  if (!READ_ONLY_METHODS.has(method)) {
    // A programming error, never reachable from user input: the fixed code
    // keeps the usual error contract and nothing about the call is echoed.
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  }
}

export type DavCredential = { username: string; secret: string };

export type DavDownload = {
  body: Uint8Array;
  etag: string | null;
  lastModified: Date | null;
  contentType: string | null;
};

export type DavServerInfo = { dav: string | null; allow: string | null };

export type DavClient = {
  /** PROPFIND of `path` (decoded, under the endpoint) at depth 0 or 1. */
  propfind(path: string, depth: 0 | 1): Promise<DavEntry[]>;
  /** GET of a file, capped at `maxBytes` (declared length and streamed). */
  get(
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<DavDownload>;
  /** OPTIONS of the endpoint itself. */
  options(): Promise<DavServerInfo>;
};

export type CreateDavClientInput = {
  /** The credentialed fetch scope's fetch: it owns the address policy and
   * refuses cross-origin redirects. */
  fetch: typeof fetch;
  endpoint: URL;
  credential: DavCredential;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
};

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getetag/><d:getlastmodified/>" +
  "<d:getcontentlength/><d:getcontenttype/>" +
  "</d:prop></d:propfind>";

/** The host's policy error is duck-typed: this package cannot import backend code. */
function isEndpointNotAllowed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED")
    return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED"
  );
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

class Timeout {
  constructor(readonly reason: "timeout" | "aborted") {}
}

/** Rejects when the signal aborts, so a fetch or read that ignores it cannot hang. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Timeout("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Timeout("aborted"));
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
 * arrives, so a hostile body is never fully read.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onTooLarge: () => WebDavError,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    if (Number(declared.trim()) > maxBytes) {
      await discard(response);
      throw onTooLarge();
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
      if (total > maxBytes) throw onTooLarge();
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

function retryDelayMs(
  response: Response | null,
  attempt: number,
  now: () => number,
): number {
  const backoff = Math.min(250 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  const header = response?.headers.get("retry-after")?.trim();
  if (!header) return backoff;
  let ms: number | null = null;
  if (/^\d{1,9}$/.test(header)) {
    ms = Number(header) * 1000;
  } else {
    const at = Date.parse(header);
    if (!Number.isNaN(at)) ms = Math.max(0, at - now());
  }
  return ms === null ? backoff : Math.min(ms, MAX_RETRY_DELAY_MS);
}

function statusError(status: number): WebDavError {
  if (status === 401) return new WebDavError("WEBDAV_UNAUTHORIZED");
  if (status === 403) return new WebDavError("WEBDAV_FORBIDDEN");
  if (status === 404 || status === 410)
    return new WebDavError("WEBDAV_NOT_FOUND");
  if (RETRY_STATUSES.has(status) || status >= 500) {
    return new WebDavError("WEBDAV_UNREACHABLE");
  }
  return new WebDavError("WEBDAV_BAD_RESPONSE");
}

/**
 * A read-only WebDAV client. The `Authorization: Basic` header is built here,
 * from the credential, for each request and is never logged, stored on an
 * error or returned. Every failure is a {@link WebDavError} with a fixed
 * message: nothing from the server, the URL or the credential is forwarded.
 * Redirects are the injected fetch's business (it refuses a cross-origin hop
 * with an endpoint-policy error, mapped to `WEBDAV_BLOCKED_ENDPOINT`); a 3xx
 * that still reaches this client is a bad response and is never followed.
 */
export function createDavClient(input: CreateDavClientInput): DavClient {
  const { endpoint } = input;
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(
    `${input.credential.username}:${input.credential.secret}`,
    "utf8",
  ).toString("base64")}`;

  /** One logical request: retried on network errors and 429/502/503/504. The
   * response handler runs inside the attempt's timeout and abort scope. */
  async function request<T>(
    method: DavMethod,
    url: string,
    options: {
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
    handle: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertReadOnlyMethod(method);
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Timeout("timeout")),
        timeoutMs,
      );
      const external = options.signal;
      const onExternalAbort = () => controller.abort(new Timeout("aborted"));
      if (external?.aborted) onExternalAbort();
      external?.addEventListener("abort", onExternalAbort, { once: true });

      let retryResponse: Response | null = null;
      try {
        const response = await abortable(
          input.fetch(url, {
            method,
            headers: {
              Authorization: authorization,
              "User-Agent": WEBDAV_USER_AGENT,
              ...options.headers,
            },
            ...(options.body === undefined ? {} : { body: options.body }),
            // Defence in depth: the credentialed scope already refuses a
            // cross-origin redirect, and a 3xx that still reaches here is a bad
            // response, never followed.
            redirect: "manual",
            signal,
          }),
          signal,
        );
        if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          retryResponse = response;
          await discard(response);
        } else {
          return await handle(response, signal);
        }
      } catch (error) {
        if (error instanceof WebDavError) throw error;
        if (isEndpointNotAllowed(error)) {
          throw new WebDavError("WEBDAV_BLOCKED_ENDPOINT");
        }
        if (error instanceof Timeout || signal.aborted) {
          throw new WebDavError("WEBDAV_UNREACHABLE");
        }
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") {
          throw new WebDavError("WEBDAV_UNREACHABLE");
        }
        if (attempt >= MAX_RETRIES) throw new WebDavError("WEBDAV_UNREACHABLE");
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      }
      await sleep(retryDelayMs(retryResponse, attempt, now));
    }
  }

  return {
    async propfind(path, depth) {
      const url = toRequestUrl(endpoint, path);
      return request(
        "PROPFIND",
        url,
        {
          headers: {
            Depth: String(depth),
            "Content-Type": "application/xml; charset=utf-8",
            Accept: "application/xml, text/xml;q=0.9",
          },
          body: PROPFIND_BODY,
        },
        async (response, signal) => {
          if (response.status !== 207) {
            await discard(response);
            throw statusError(response.status);
          }
          const bytes = await readCapped(
            response,
            MAX_MULTISTATUS_BYTES,
            signal,
            () => new WebDavError("WEBDAV_BAD_RESPONSE"),
          );
          return parseMultistatus(new TextDecoder("utf-8").decode(bytes));
        },
      );
    },

    async get(path, options) {
      const url = toRequestUrl(endpoint, path);
      return request(
        "GET",
        url,
        { headers: { Accept: "*/*" }, signal: options.signal },
        async (response, signal) => {
          if (response.status !== 200) {
            await discard(response);
            throw statusError(response.status);
          }
          const body = await readCapped(
            response,
            options.maxBytes,
            signal,
            () => new WebDavError("WEBDAV_TOO_LARGE"),
          );
          const modified = response.headers.get("last-modified");
          const parsed = modified === null ? null : new Date(modified);
          return {
            body,
            etag: response.headers.get("etag"),
            lastModified:
              parsed !== null && !Number.isNaN(parsed.getTime())
                ? parsed
                : null,
            contentType: response.headers.get("content-type"),
          };
        },
      );
    },

    async options() {
      return request(
        "OPTIONS",
        toRequestUrl(endpoint, "/"),
        {},
        async (response) => {
          await discard(response);
          if (response.status < 200 || response.status > 299) {
            throw statusError(response.status);
          }
          return {
            dav: response.headers.get("dav"),
            allow: response.headers.get("allow"),
          };
        },
      );
    },
  };
}

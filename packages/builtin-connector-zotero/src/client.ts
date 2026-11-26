import { ZoteroError } from "./errors";
import {
  isLibraryPrefix,
  isUsableApiKey,
  type ZoteroLibraryPrefix,
} from "./identity";
import {
  MAX_BACKOFF_WAIT_MS,
  MAX_OBJECTS,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  ZOTERO_USER_AGENT,
} from "./limits";

/** The only host this connector talks to. */
const ZOTERO_ORIGIN = "https://api.zotero.org";

/** The only method this connector can send. */
export type ZoteroMethod = "GET";

/** Throws unless `method` is exactly `GET`. */
export function assertReadOnly(method: string): asserts method is ZoteroMethod {
  if (method !== "GET") {
    // A programming error, never reachable from user input: the fixed code
    // keeps the usual error contract and nothing about the call is echoed.
    throw new ZoteroError("ZOTERO_BAD_RESPONSE");
  }
}

export type ZoteroKeyInfo = {
  userId: string;
  username: string | null;
  access: {
    userLibrary: boolean;
    userNotes: boolean;
    groupsAll: boolean;
    /** Group id to whether the key may read that group's library. */
    groups: ReadonlyMap<string, boolean>;
  };
};

export type ZoteroPage =
  | { status: "not_modified"; libraryVersion: number }
  | {
      status: "ok";
      libraryVersion: number;
      totalResults: number;
      objects: unknown[];
    };

export type ZoteroClient = {
  /** `GET /keys/current`: who the key belongs to and what it may read. */
  keyInfo(): Promise<ZoteroKeyInfo>;
  /** One page of `collections` or `items` of the library. */
  getPage(
    path: "collections" | "items",
    options: { start: number; ifModifiedSinceVersion?: number },
  ): Promise<ZoteroPage>;
  /** One item, `items/KEY`. */
  getObject(path: string): Promise<{ libraryVersion: number; object: unknown }>;
  /** A bounded child list, `items/KEY/children`, paged to completion. */
  getList(path: string): Promise<unknown[]>;
};

export type CreateZoteroClientInput = {
  /** The credentialed fetch scope's fetch: it owns the address policy. */
  fetch: typeof fetch;
  credential: { secret: string };
  libraryPrefix: ZoteroLibraryPrefix;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

const ITEM_PATH = /^items\/[A-Z0-9]{8}$/;
const CHILDREN_PATH = /^items\/[A-Z0-9]{8}\/children$/;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

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
): Promise<Uint8Array> {
  const tooLarge = () => new ZoteroError("ZOTERO_TOO_LARGE");
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

/** A non-negative whole number in a header, or null when absent or malformed. */
function headerInteger(response: Response, name: string): number | null {
  const value = response.headers.get(name)?.trim();
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** Seconds in `Retry-After` (the HTTP-date form is not used by Zotero). */
function retryDelayMs(response: Response | null, attempt: number): number {
  const fallback = 500 * (attempt + 1);
  if (response === null) return fallback;
  const seconds = headerInteger(response, "retry-after");
  if (seconds === null) return fallback;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

type Reply =
  | { kind: "not_modified"; libraryVersion: number | null }
  | {
      kind: "ok";
      libraryVersion: number | null;
      totalResults: number | null;
      json: unknown;
    };

type Target = {
  /** `keys/current` rather than a library path: changes the status mapping. */
  keyScope: boolean;
  url: string;
  headers?: Record<string, string>;
  allowNotModified: boolean;
};

/**
 * A read-only Zotero Web API v3 client for one library. The API key is sent
 * only in the `Zotero-API-Key` header, never in a query string. Every URL is
 * built here from the fixed origin and validated pieces: nothing in a response
 * (not even a `Link` header) is ever followed. Every failure is a
 * {@link ZoteroError} with a fixed message: nothing from the server, the URL
 * or the key is forwarded.
 */
export function createZoteroClient(
  input: CreateZoteroClientInput,
): ZoteroClient {
  if (!isLibraryPrefix(input.libraryPrefix)) {
    throw new ZoteroError("ZOTERO_CONFIG_INVALID");
  }
  const { secret } = input.credential;
  if (!isUsableApiKey(secret)) throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");

  const libraryPrefix = input.libraryPrefix;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const external = input.signal;

  let requestCount = 0;
  /** Seconds the last successful response asked the next request to wait. */
  let pendingBackoffSeconds: number | null = null;

  /** Honours a `Backoff` header from the previous successful response. */
  async function waitOutBackoff(): Promise<void> {
    if (pendingBackoffSeconds === null) return;
    const seconds = pendingBackoffSeconds;
    pendingBackoffSeconds = null;
    if (seconds * 1000 > MAX_BACKOFF_WAIT_MS) {
      throw new ZoteroError("ZOTERO_RATE_LIMITED");
    }
    if (seconds > 0) await sleep(seconds * 1000);
  }

  /** One logical request: retried on network errors and 429/502/503/504. */
  async function perform(target: Target): Promise<Reply> {
    await waitOutBackoff();
    for (let attempt = 0; ; attempt += 1) {
      if (external?.aborted) throw new ZoteroError("ZOTERO_UNAVAILABLE");
      if (requestCount >= MAX_REQUESTS)
        throw new ZoteroError("ZOTERO_TOO_LARGE");
      requestCount += 1;

      const method = "GET";
      assertReadOnly(method);
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Timeout("timeout")),
        timeoutMs,
      );
      const onExternalAbort = () => controller.abort(new Timeout("aborted"));
      external?.addEventListener("abort", onExternalAbort, { once: true });

      let retryResponse: Response | null = null;
      try {
        const response = await abortable(
          input.fetch(target.url, {
            method,
            headers: {
              "Zotero-API-Key": secret,
              "Zotero-API-Version": "3",
              "User-Agent": ZOTERO_USER_AGENT,
              Accept: "application/json",
              ...target.headers,
            },
            signal,
          }),
          signal,
        );
        if (RETRY_STATUSES.has(response.status)) {
          if (attempt >= MAX_RETRIES) {
            await discard(response);
            throw new ZoteroError(
              response.status === 429
                ? "ZOTERO_RATE_LIMITED"
                : "ZOTERO_UNAVAILABLE",
            );
          }
          retryResponse = response;
          await discard(response);
        } else {
          return await handle(response, target, signal);
        }
      } catch (error) {
        if (error instanceof ZoteroError) throw error;
        if (isEndpointNotAllowed(error)) {
          throw new ZoteroError("ZOTERO_BLOCKED_ENDPOINT");
        }
        if (error instanceof Timeout || signal.aborted) {
          throw new ZoteroError("ZOTERO_UNAVAILABLE");
        }
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") {
          throw new ZoteroError("ZOTERO_UNAVAILABLE");
        }
        if (attempt >= MAX_RETRIES) throw new ZoteroError("ZOTERO_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      }
      await sleep(retryDelayMs(retryResponse, attempt));
    }
  }

  async function handle(
    response: Response,
    target: Target,
    signal: AbortSignal,
  ): Promise<Reply> {
    const { status } = response;
    if (status === 304) {
      await discard(response);
      if (!target.allowNotModified)
        throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      pendingBackoffSeconds = headerInteger(response, "backoff");
      return {
        kind: "not_modified",
        libraryVersion: headerInteger(response, "last-modified-version"),
      };
    }
    if (status === 200) {
      const bytes = await readCapped(response, maxBytes, signal);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      } catch {
        throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      }
      pendingBackoffSeconds = headerInteger(response, "backoff");
      return {
        kind: "ok",
        json,
        libraryVersion: headerInteger(response, "last-modified-version"),
        totalResults: headerInteger(response, "total-results"),
      };
    }
    await discard(response);
    if (status === 401) throw new ZoteroError("ZOTERO_REAUTH_REQUIRED");
    if (status === 403) {
      throw new ZoteroError(
        target.keyScope
          ? "ZOTERO_REAUTH_REQUIRED"
          : "ZOTERO_KEY_INSUFFICIENT_ACCESS",
      );
    }
    if (status === 404) {
      throw new ZoteroError(
        target.keyScope ? "ZOTERO_REAUTH_REQUIRED" : "ZOTERO_LIBRARY_NOT_FOUND",
      );
    }
    if (status >= 400) throw new ZoteroError("ZOTERO_UNAVAILABLE");
    // A redirect or another success code: never followed, never trusted.
    throw new ZoteroError("ZOTERO_BAD_RESPONSE");
  }

  function libraryTarget(
    path: string,
    params: Record<string, string>,
    headers?: Record<string, string>,
  ): Target {
    const query = new URLSearchParams(params).toString();
    return {
      keyScope: false,
      url: `${ZOTERO_ORIGIN}/${libraryPrefix}/${path}?${query}`,
      headers,
      allowNotModified: headers !== undefined,
    };
  }

  function requireVersion(reply: Reply & { kind: "ok" }): number {
    if (reply.libraryVersion === null) {
      throw new ZoteroError("ZOTERO_BAD_RESPONSE");
    }
    return reply.libraryVersion;
  }

  const BASE_PARAMS = {
    limit: String(PAGE_SIZE),
    format: "json",
    include: "data",
  };

  function pageParams(path: string, start: number): Record<string, string> {
    return {
      ...BASE_PARAMS,
      ...(path === "items" ? { sort: "dateAdded", direction: "asc" } : {}),
      start: String(start),
    };
  }

  function assertStart(start: number): void {
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new ZoteroError("ZOTERO_CONFIG_INVALID");
    }
  }

  return {
    async keyInfo() {
      const reply = await perform({
        keyScope: true,
        url: `${ZOTERO_ORIGIN}/keys/current`,
        allowNotModified: false,
      });
      if (reply.kind !== "ok") throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      return parseKeyInfo(reply.json);
    },

    async getPage(path, options) {
      assertStart(options.start);
      const { ifModifiedSinceVersion } = options;
      if (
        ifModifiedSinceVersion !== undefined &&
        (!Number.isSafeInteger(ifModifiedSinceVersion) ||
          ifModifiedSinceVersion < 0)
      ) {
        throw new ZoteroError("ZOTERO_CONFIG_INVALID");
      }
      const reply = await perform(
        libraryTarget(
          path,
          pageParams(path, options.start),
          ifModifiedSinceVersion === undefined
            ? undefined
            : { "If-Modified-Since-Version": String(ifModifiedSinceVersion) },
        ),
      );
      if (reply.kind === "not_modified") {
        if (reply.libraryVersion === null) {
          throw new ZoteroError("ZOTERO_BAD_RESPONSE");
        }
        return { status: "not_modified", libraryVersion: reply.libraryVersion };
      }
      const libraryVersion = requireVersion(reply);
      if (!Array.isArray(reply.json) || reply.totalResults === null) {
        throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      }
      return {
        status: "ok",
        libraryVersion,
        totalResults: reply.totalResults,
        objects: reply.json,
      };
    },

    async getObject(path) {
      if (!ITEM_PATH.test(path)) throw new ZoteroError("ZOTERO_CONFIG_INVALID");
      const reply = await perform(
        libraryTarget(path, { format: "json", include: "data" }),
      );
      if (reply.kind !== "ok") throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      const libraryVersion = requireVersion(reply);
      const { json } = reply;
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      }
      return { libraryVersion, object: json };
    },

    async getList(path) {
      if (!CHILDREN_PATH.test(path)) {
        throw new ZoteroError("ZOTERO_CONFIG_INVALID");
      }
      const all: unknown[] = [];
      for (let start = 0; ; start += PAGE_SIZE) {
        const reply = await perform(
          libraryTarget(path, pageParams(path, start)),
        );
        if (reply.kind !== "ok") throw new ZoteroError("ZOTERO_BAD_RESPONSE");
        requireVersion(reply);
        if (!Array.isArray(reply.json)) {
          throw new ZoteroError("ZOTERO_BAD_RESPONSE");
        }
        all.push(...reply.json);
        if (all.length > MAX_OBJECTS) throw new ZoteroError("ZOTERO_TOO_LARGE");
        const done =
          reply.json.length < PAGE_SIZE ||
          (reply.totalResults !== null && all.length >= reply.totalResults);
        if (done) return all;
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `access.<scope>.library`-style flags; anything but `true` is false. */
function flag(value: unknown, name: string): boolean {
  return isRecord(value) && value[name] === true;
}

function parseKeyInfo(json: unknown): ZoteroKeyInfo {
  if (!isRecord(json)) throw new ZoteroError("ZOTERO_BAD_RESPONSE");
  const { userID, username, access } = json;
  const userId =
    typeof userID === "number" && Number.isSafeInteger(userID) && userID > 0
      ? String(userID)
      : typeof userID === "string" && /^[1-9][0-9]{0,11}$/.test(userID)
        ? userID
        : null;
  if (userId === null || !isRecord(access)) {
    throw new ZoteroError("ZOTERO_BAD_RESPONSE");
  }
  const groups = new Map<string, boolean>();
  const groupAccess = isRecord(access.groups) ? access.groups : {};
  for (const [id, entry] of Object.entries(groupAccess)) {
    if (id !== "all") groups.set(id, flag(entry, "library"));
  }
  return {
    userId,
    username: typeof username === "string" ? username : null,
    access: {
      userLibrary: flag(access.user, "library"),
      userNotes: flag(access.user, "notes"),
      groupsAll: flag(groupAccess.all, "library"),
      groups,
    },
  };
}

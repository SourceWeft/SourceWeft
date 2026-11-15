import { Buffer } from "node:buffer";
import { ConnectorItemSkipError, type OAuthTokenSet } from "@sourceweft/contracts";
import { DROPBOX_ITEM_ID_PATTERN } from "./contribution";

// Dropbox-specific HTTP client. Kept independent of Drive's own copy on
// purpose (packages are independent; see Ruling B): this file owns its own
// token exchange, request wrapper and `readCapped`, mirroring Drive's
// structure and conventions without importing from it.
const API_URL = "https://api.dropboxapi.com";
const CONTENT_URL = "https://content.dropboxapi.com";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REQUEST_TIMEOUT_MS = 30000;
/** Fixed page size for `search_v2`/`search/continue_v2`; the interface takes
 * no limit argument, so this is the whole dial (see global constraints). */
const SEARCH_MAX_RESULTS = 50;
// Derived from the single pattern contribution.ts also uses for configSchema.
const ITEM_ID = new RegExp(DROPBOX_ITEM_ID_PATTERN);
/** Cap for a `.paper` export's markdown body, same constant style as
 * Drive's `GOOGLE_DRIVE_EXPORT_MAX_BYTES`. */
const DROPBOX_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export class DropboxAdapterError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DropboxAdapterError";
  }
}

/** The Dropbox file/folder metadata fields this connector reads. */
export type DropboxEntry = {
  ".tag": "file" | "folder" | "deleted";
  id?: string;
  name?: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
  rev?: string;
  is_downloadable?: boolean;
};

export type DropboxAccount = {
  account_id: string;
  email?: string;
  name?: { display_name?: string };
  root_info?: {
    root_namespace_id?: string;
    home_namespace_id?: string;
  };
};

export type DropboxListing = {
  entries: DropboxEntry[];
  cursor: string;
  hasMore: boolean;
};

/**
 * Validates a Dropbox item id before it is placed into a content-API path
 * argument. The server's config schema enforces the same pattern, but the
 * adapter never trusts an id it is about to send to Dropbox.
 */
export function assertDropboxId(value: unknown): string {
  if (typeof value !== "string" || !ITEM_ID.test(value)) {
    throw new DropboxAdapterError(400, "DROPBOX_INVALID_ID", "Invalid Dropbox item ID");
  }
  return value;
}

/**
 * Dropbox requires the `Dropbox-API-Arg` header to be pure ASCII.
 * `JSON.stringify` alone leaves non-ASCII characters (e.g. in a file path)
 * literal, so every character above U+007F is re-escaped as a `\uXXXX`
 * sequence.
 */
export function dropboxApiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The `Dropbox-API-Path-Root` namespace id for a team account whose current
 * root differs from its home namespace, or `null` for an ordinary personal
 * account (no header is sent in that case).
 */
export function pathRootFor(account: DropboxAccount): string | null {
  const rootNamespaceId = account.root_info?.root_namespace_id;
  const homeNamespaceId = account.root_info?.home_namespace_id;
  if (rootNamespaceId && rootNamespaceId !== homeNamespaceId) {
    return rootNamespaceId;
  }
  return null;
}

/** Builds a mapped error whose message always carries Dropbox's own status
 * (never the mapped `statusCode`, the token, a header or a body). */
function requestFailed(status: number, statusCode: number, code: string): DropboxAdapterError {
  return new DropboxAdapterError(statusCode, code, `Dropbox request failed (${status})`);
}

/**
 * Maps a non-2xx status onto the error the platform reads, for every call
 * except the token endpoint. Used both for statuses that are never 409 and,
 * for a 409, as the fallback once the body carries no special-cased
 * `error_summary`.
 */
function mapStatus(status: number): DropboxAdapterError {
  if (status === 401) return requestFailed(status, 401, "DROPBOX_REAUTH_REQUIRED");
  if (status === 429) return requestFailed(status, 429, "DROPBOX_RATE_LIMITED");
  if (status >= 500) return requestFailed(status, 503, "DROPBOX_UNAVAILABLE");
  return requestFailed(status, status, "DROPBOX_REQUEST_FAILED");
}

/** Maps a non-`not_found` 409 from discovery (`getMetadata`/`listFolder`)
 * to a message naming the cause, using only the error_summary's first path
 * segment (e.g. `restricted_content`, `locked`) — never a body or token. */
function discoveryRequestFailed(summary: string | null): DropboxAdapterError {
  if (summary) {
    const tag = summary.split("/")[0];
    return new DropboxAdapterError(
      409,
      "DROPBOX_REQUEST_FAILED",
      `Dropbox refused to read a selected item (${tag}). Remove it from the selection or try again later.`,
    );
  }
  return requestFailed(409, 409, "DROPBOX_REQUEST_FAILED");
}

/** Reads a 409 body's `error_summary`, tolerating a non-JSON body (treated
 * as a generic 409 by returning `null`). */
async function errorSummaryOf(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const body = JSON.parse(text) as { error_summary?: unknown };
    return typeof body.error_summary === "string" ? body.error_summary : null;
  } catch {
    return null;
  }
}

/** Shared 409 interpretation for `downloadBytes`/`exportPaperMarkdown`. */
async function contentError(response: Response): Promise<Error> {
  if (response.status === 409) {
    const summary = await errorSummaryOf(response);
    if (summary?.startsWith("path/not_found")) {
      return requestFailed(409, 404, "DROPBOX_NOT_FOUND");
    }
    if (summary?.includes("restricted_content")) {
      return new ConnectorItemSkipError("unreadable");
    }
    if (summary?.includes("non_exportable")) {
      return new ConnectorItemSkipError("unsupported_type");
    }
  }
  return mapStatus(response.status);
}

/**
 * Reads a response body into a Buffer without ever holding more than
 * `maxBytes`: the declared `Content-Length` short-circuits, and the stream
 * is abandoned the moment the running total passes the cap. Dropbox's own
 * copy of Drive's `readCapped` (Ruling B: packages are independent).
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ConnectorItemSkipError("too_large");
    }
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ConnectorItemSkipError("too_large");
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Best effort: the cap is already enforced by throwing below.
      }
      throw new ConnectorItemSkipError("too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function pathRootHeader(pathRoot: string | null): Record<string, string> {
  if (!pathRoot) return {};
  return {
    "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "root", root: pathRoot }),
  };
}

function toListing(data: {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}): DropboxListing {
  return {
    entries: data.entries ?? [],
    cursor: data.cursor ?? "",
    hasMore: data.has_more ?? false,
  };
}

function toSearchListing(data: {
  matches?: Array<{ metadata?: { metadata?: DropboxEntry } }>;
  cursor?: string;
  has_more?: boolean;
}): DropboxListing {
  const entries: DropboxEntry[] = [];
  for (const match of data.matches ?? []) {
    const entry = match.metadata?.metadata;
    if (entry) entries.push(entry);
  }
  return {
    entries,
    cursor: data.cursor ?? "",
    hasMore: data.has_more ?? false,
  };
}

export type DropboxClientOptions = {
  clientId: string;
  clientSecret: string;
  fetcher: typeof fetch;
};

export type DropboxClient = ReturnType<typeof createDropboxClient>;

export function createDropboxClient(options: DropboxClientOptions) {
  const { clientId, clientSecret, fetcher } = options;

  /** Issues a single request (no retry: the platform's sync orchestrator
   * owns retrying a 429/5xx). Network errors and timeouts are normalized to
   * `503 DROPBOX_UNAVAILABLE`, same as a provider 5xx. */
  async function request(url: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DropboxAdapterError(503, "DROPBOX_UNAVAILABLE", "Dropbox is unavailable");
    }
  }

  function postRpc(
    path: string,
    token: string,
    body: unknown,
    pathRoot: string | null,
  ): Promise<Response> {
    return request(`${API_URL}${path}`, token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...pathRootHeader(pathRoot),
      },
      body: JSON.stringify(body ?? null),
    });
  }

  function postContent(
    path: string,
    token: string,
    apiArg: unknown,
    pathRoot: string | null,
  ): Promise<Response> {
    return request(`${CONTENT_URL}${path}`, token, {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": dropboxApiArg(apiArg),
        ...pathRootHeader(pathRoot),
      },
    });
  }

  async function tokenRequest(params: URLSearchParams): Promise<OAuthTokenSet> {
    params.set("client_id", clientId);
    params.set("client_secret", clientSecret);
    let response: Response;
    try {
      response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DropboxAdapterError(503, "DROPBOX_UNAVAILABLE", "Dropbox is unavailable");
    }
    if (!response.ok) {
      if (response.status === 400) {
        throw requestFailed(400, 400, "DROPBOX_REAUTH_REQUIRED");
      }
      throw mapStatus(response.status);
    }
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: payload.access_token ?? "",
      // A refresh response carries no refresh_token: the caller keeps using
      // the one it already stored.
      refreshToken: payload.refresh_token ?? undefined,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
      scopes: payload.scope ? payload.scope.split(" ").filter(Boolean) : undefined,
    };
  }

  return {
    exchangeAuthorizationCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
      return tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      );
    },
    refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet> {
      return tokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      );
    },
    async getCurrentAccount(token: string): Promise<DropboxAccount> {
      const response = await postRpc("/2/users/get_current_account", token, null, null);
      if (!response.ok) throw mapStatus(response.status);
      return (await response.json()) as DropboxAccount;
    },
    /** Returns the entry, or `null` when Dropbox reports `path/not_found`.
     * Every other error propagates so the page fails rather than archiving
     * a live file. `path` is a plain string (an `id:…` or a `/path`); only
     * the caller's own id arguments (download/export) are validated. */
    async getMetadata(
      token: string,
      pathRoot: string | null,
      path: string,
    ): Promise<DropboxEntry | null> {
      const response = await postRpc("/2/files/get_metadata", token, { path }, pathRoot);
      if (response.ok) return (await response.json()) as DropboxEntry;
      if (response.status === 409) {
        const summary = await errorSummaryOf(response);
        if (summary?.startsWith("path/not_found")) return null;
        throw discoveryRequestFailed(summary);
      }
      throw mapStatus(response.status);
    },
    /** Returns `null` when the path is gone or is no longer a folder; every
     * other error propagates. Always sends `include_non_downloadable_files`
     * so non-downloadable entries (e.g. a `.paper` doc) are still listed. */
    async listFolder(
      token: string,
      pathRoot: string | null,
      input: { path: string; recursive: boolean; limit: number },
    ): Promise<DropboxListing | null> {
      const response = await postRpc(
        "/2/files/list_folder",
        token,
        {
          path: input.path,
          recursive: input.recursive,
          limit: input.limit,
          include_non_downloadable_files: true,
        },
        pathRoot,
      );
      if (response.ok) return toListing(await response.json());
      if (response.status === 409) {
        const summary = await errorSummaryOf(response);
        if (summary?.startsWith("path/not_found") || summary?.startsWith("path/not_folder")) {
          return null;
        }
        throw discoveryRequestFailed(summary);
      }
      throw mapStatus(response.status);
    },
    /** A `reset` cursor is reported as retryable 503 rather than restarting
     * the listing itself: the caller's run fails and a fresh sync starts
     * a new `listFolder` from scratch. */
    async listFolderContinue(
      token: string,
      pathRoot: string | null,
      cursor: string,
    ): Promise<DropboxListing> {
      const response = await postRpc(
        "/2/files/list_folder/continue",
        token,
        { cursor },
        pathRoot,
      );
      if (response.ok) return toListing(await response.json());
      if (response.status === 409) {
        const summary = await errorSummaryOf(response);
        if (summary?.startsWith("reset")) {
          throw requestFailed(409, 503, "DROPBOX_CURSOR_RESET");
        }
      }
      throw mapStatus(response.status);
    },
    async search(token: string, pathRoot: string | null, query: string): Promise<DropboxListing> {
      const response = await postRpc(
        "/2/files/search_v2",
        token,
        {
          query,
          options: {
            filename_only: true,
            file_status: "active",
            max_results: SEARCH_MAX_RESULTS,
          },
        },
        pathRoot,
      );
      if (response.ok) return toSearchListing(await response.json());
      throw mapStatus(response.status);
    },
    async searchContinue(
      token: string,
      pathRoot: string | null,
      cursor: string,
    ): Promise<DropboxListing> {
      const response = await postRpc(
        "/2/files/search/continue_v2",
        token,
        { cursor },
        pathRoot,
      );
      if (response.ok) return toSearchListing(await response.json());
      throw mapStatus(response.status);
    },
    async downloadBytes(
      token: string,
      pathRoot: string | null,
      id: string,
      maxBytes: number,
    ): Promise<Buffer> {
      const itemId = assertDropboxId(id);
      const response = await postContent(
        "/2/files/download",
        token,
        { path: itemId },
        pathRoot,
      );
      if (response.ok) return readCapped(response, maxBytes);
      throw await contentError(response);
    },
    async exportPaperMarkdown(
      token: string,
      pathRoot: string | null,
      id: string,
    ): Promise<string> {
      const itemId = assertDropboxId(id);
      const response = await postContent(
        "/2/files/export",
        token,
        { path: itemId, export_format: "markdown" },
        pathRoot,
      );
      if (response.ok) {
        try {
          const buffer = await readCapped(response, DROPBOX_EXPORT_MAX_BYTES);
          return buffer.toString("utf8");
        } catch (error) {
          if (error instanceof ConnectorItemSkipError && error.reason === "too_large") {
            throw new ConnectorItemSkipError("export_too_large");
          }
          throw error;
        }
      }
      throw await contentError(response);
    },
  };
}

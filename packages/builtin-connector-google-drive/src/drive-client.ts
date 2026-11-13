import { Buffer } from "node:buffer";
import {
  ConnectorItemSkipError,
  type ConnectorItemSkipReason,
  type OAuthTokenSet,
} from "@sourceweft/contracts";

// Drive's own token exchange and request wrapper are kept in this package on
// purpose: the Gmail connector is under Google review and must not be touched,
// so Drive carries its own copy rather than importing from it.
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Shares its character class with configSchema's fileIds item pattern in
// contribution.ts; keep both in sync.
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const REQUEST_TIMEOUT_MS = 30000;
// The token check before a picker session runs on a click; keep it short.
const TOKEN_CHECK_TIMEOUT_MS = 5000;
/**
 * Defensive client-side cap on a text export's body. Google's own export
 * limit is 10 MB; this cap is intentionally looser so it never fires before
 * the provider's own `exportSizeLimitExceeded` error does, while still
 * bounding memory if that provider behavior ever changes.
 */
const GOOGLE_DRIVE_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export class GoogleDriveAdapterError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleDriveAdapterError";
  }
}

/** The Drive file-metadata fields this connector reads. */
export type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
  webViewLink?: string;
};

export type DriveAboutUser = {
  emailAddress?: string;
  displayName?: string;
  permissionId?: string;
};

/**
 * Validates a Drive file id before it is interpolated into any request URL.
 * The server's config schema enforces the same pattern, but the adapter never
 * trusts an id it is about to place in a path.
 */
export function assertDriveFileId(value: unknown): string {
  if (typeof value !== "string" || !FILE_ID.test(value)) {
    throw new GoogleDriveAdapterError(
      400,
      "GOOGLE_DRIVE_INVALID_ID",
      "Invalid Google Drive file ID",
    );
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps a non-2xx provider status onto the error the platform reads. The
 * platform retries on `statusCode` 429 or `>= 500`, so 5xx is normalized to
 * 503 while 429 and client errors keep their real status.
 */
function mapResponseError(status: number): GoogleDriveAdapterError {
  const code =
    status === 401
      ? "GOOGLE_DRIVE_REAUTH_REQUIRED"
      : status === 429
        ? "GOOGLE_DRIVE_RATE_LIMITED"
        : status >= 500
          ? "GOOGLE_DRIVE_UNAVAILABLE"
          : "GOOGLE_DRIVE_REQUEST_FAILED";
  const statusCode = status >= 500 ? 503 : status;
  // The message never carries the token, the Authorization header, or the body.
  return new GoogleDriveAdapterError(
    statusCode,
    code,
    `Google Drive request failed (${status})`,
  );
}

async function isExportSizeLimitExceeded(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: string }> };
      errors?: Array<{ reason?: string }>;
    };
    const reasons = body?.error?.errors ?? body?.errors ?? [];
    return reasons.some((entry) => entry?.reason === "exportSizeLimitExceeded");
  } catch {
    return false;
  }
}

/**
 * Reads a response body into a Buffer without ever holding more than `maxBytes`:
 * the declared `Content-Length` short-circuits, and the stream is abandoned the
 * moment the running total passes the cap.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  skipReason: ConnectorItemSkipReason = "too_large",
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ConnectorItemSkipError(skipReason);
    }
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ConnectorItemSkipError(skipReason);
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
      throw new ConnectorItemSkipError(skipReason);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export type DriveClientOptions = {
  clientId: string;
  clientSecret: string;
  fetcher: typeof fetch;
};

export type DriveClient = ReturnType<typeof createDriveClient>;

export function createDriveClient(options: DriveClientOptions) {
  const { clientId, clientSecret, fetcher } = options;

  /**
   * Issues a GET (or other) request with a bounded backoff retry. Only GET is
   * retried, and only on a network error or a 429/5xx response; the retried
   * requests are the metadata, about, export, and download reads. Returns the
   * raw Response so callers can branch on status (export size limit, streaming).
   */
  async function request(
    url: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const retryableMethod = !init.method || init.method === "GET";
    for (let attempt = 0; attempt < (retryableMethod ? 3 : 1); attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...init.headers,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (retryableMethod && attempt < 2) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw new GoogleDriveAdapterError(
          503,
          "GOOGLE_DRIVE_UNAVAILABLE",
          "Google Drive is unavailable",
        );
      }
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (
        !response.ok &&
        retryableMethod &&
        retryableStatus &&
        attempt < 2
      ) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(5000, retryAfter * 1000)
            : 250 * 2 ** attempt;
        await delay(wait);
        continue;
      }
      return response;
    }
    throw new GoogleDriveAdapterError(
      503,
      "GOOGLE_DRIVE_UNAVAILABLE",
      "Google Drive is unavailable",
    );
  }

  async function getJson<T>(url: string, token: string): Promise<T> {
    const response = await request(url, token);
    if (response.ok) return (await response.json()) as T;
    throw mapResponseError(response.status);
  }

  async function tokenRequest(params: URLSearchParams): Promise<OAuthTokenSet> {
    if (!clientId || !clientSecret) {
      throw new GoogleDriveAdapterError(
        500,
        "GOOGLE_DRIVE_OAUTH_CONFIG_MISSING",
        "Google Drive OAuth client is not configured",
      );
    }
    params.set("client_id", clientId);
    params.set("client_secret", clientSecret);
    let response: Response;
    try {
      response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new GoogleDriveAdapterError(
        503,
        "GOOGLE_DRIVE_OAUTH_UNAVAILABLE",
        "Google OAuth is unavailable",
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new GoogleDriveAdapterError(
        retryable ? 503 : 401,
        retryable ? "GOOGLE_DRIVE_OAUTH_UNAVAILABLE" : "GOOGLE_DRIVE_OAUTH_FAILED",
        retryable
          ? "Google OAuth is unavailable"
          : "Google OAuth authorization failed",
      );
    }
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new GoogleDriveAdapterError(
        502,
        "GOOGLE_DRIVE_OAUTH_INVALID",
        "Google OAuth returned no access token",
      );
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
      scopes: payload.scope?.split(/\s+/).filter(Boolean),
    };
  }

  async function throwExport(response: Response): Promise<never> {
    if (response.status === 403 && (await isExportSizeLimitExceeded(response))) {
      throw new ConnectorItemSkipError("export_too_large");
    }
    throw mapResponseError(response.status);
  }

  return {
    exchangeAuthorizationCode(
      code: string,
      redirectUri: string,
    ): Promise<OAuthTokenSet> {
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
    /**
     * Asks Google once whether it still accepts this token. This runs on a
     * click (before a picker session is issued), so it waits a few seconds at
     * most and is never retried, unlike the sync reads above. Only a refusal
     * (401) throws: a timeout, a network error or a 5xx says nothing about the
     * token, and the caller carries on as it would have without the check.
     */
    async assertTokenAccepted(token: string): Promise<void> {
      let response: Response;
      try {
        response = await fetcher(
          `${DRIVE_API}/about?fields=user(permissionId)`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS),
          },
        );
      } catch {
        return;
      }
      if (response.status === 401) {
        throw mapResponseError(response.status);
      }
    },
    async getAbout(token: string): Promise<DriveAboutUser> {
      const about = await getJson<{ user?: DriveAboutUser }>(
        `${DRIVE_API}/about?fields=user(emailAddress,displayName,permissionId)`,
        token,
      );
      return about.user ?? {};
    },
    /** Returns the file metadata, or `null` when it is gone: only a 404 on the
     * metadata request or `trashed: true` counts as gone. Every other error
     * propagates so the page fails rather than archiving a live file. */
    async getFileMetadata(
      token: string,
      id: string,
    ): Promise<DriveFile | null> {
      const fileId = assertDriveFileId(id);
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,md5Checksum,size,trashed,webViewLink&supportsAllDrives=true`;
      let file: DriveFile;
      try {
        file = await getJson<DriveFile>(url, token);
      } catch (error) {
        if (
          error instanceof GoogleDriveAdapterError &&
          error.statusCode === 404
        ) {
          return null;
        }
        throw error;
      }
      return file.trashed === true ? null : file;
    },
    async exportText(
      token: string,
      id: string,
      exportMimeType: string,
    ): Promise<string> {
      const fileId = assertDriveFileId(id);
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
      const response = await request(url, token);
      if (response.ok) {
        const buffer = await readCapped(
          response,
          GOOGLE_DRIVE_EXPORT_MAX_BYTES,
          "export_too_large",
        );
        return buffer.toString("utf8");
      }
      return throwExport(response);
    },
    async exportBytes(
      token: string,
      id: string,
      exportMimeType: string,
      maxBytes: number,
    ): Promise<Buffer> {
      const fileId = assertDriveFileId(id);
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
      const response = await request(url, token);
      if (response.ok) return readCapped(response, maxBytes);
      return throwExport(response);
    },
    async downloadBytes(
      token: string,
      id: string,
      maxBytes: number,
    ): Promise<Buffer> {
      const fileId = assertDriveFileId(id);
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const response = await request(url, token);
      if (response.ok) return readCapped(response, maxBytes);
      throw mapResponseError(response.status);
    },
  };
}

import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";

/**
 * Fixed-code, fixed-message errors for the Nextcloud Login Flow v2 and OCS
 * exchanges. Like {@link WebDavError}, the message is a constant English string
 * per code: it never contains the server URL, a path or query, the poll token,
 * the login name, the app password or any response body, and no `cause` is set.
 * `apps/backend` surfaces it through `toConnectorError`, which copies
 * `statusCode`, `code` and `message` onto a `ConnectorError`.
 *
 *  - `NEXTCLOUD_LOGIN_FLOW_INVALID` — a cross-origin login/poll URL, a malformed
 *    or oversize body, or a missing/malformed field (400).
 *  - `NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED` — the `login/v2` endpoint is missing
 *    (404/405) or the server does not speak Login Flow v2 (422).
 *  - `NEXTCLOUD_UNREACHABLE` — a network error, a timeout or a 5xx (502).
 *  - `NEXTCLOUD_BLOCKED_ENDPOINT` — the credentialed fetch scope refused the
 *    address or a cross-origin redirect (422), duck-typed like the WebDAV
 *    `WEBDAV_BLOCKED_ENDPOINT` mapping.
 *
 * There is deliberately no `expired` code for a poll 404: a 404 is reported as
 * `pending` (indistinguishable from "not approved yet"); only the backend's own
 * flow expiry ends a flow.
 */
export type NextcloudLoginFlowErrorCode =
  | "NEXTCLOUD_LOGIN_FLOW_INVALID"
  | "NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED"
  | "NEXTCLOUD_UNREACHABLE"
  | "NEXTCLOUD_BLOCKED_ENDPOINT";

const FAILURES: Record<
  NextcloudLoginFlowErrorCode,
  { statusCode: number; message: string }
> = {
  NEXTCLOUD_LOGIN_FLOW_INVALID: {
    statusCode: 400,
    message: "The Nextcloud login response was not valid.",
  },
  NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED: {
    statusCode: 422,
    message: "This server does not support Nextcloud Login Flow v2.",
  },
  NEXTCLOUD_UNREACHABLE: {
    statusCode: 502,
    message: "The Nextcloud server could not be reached.",
  },
  NEXTCLOUD_BLOCKED_ENDPOINT: {
    statusCode: 422,
    message: "The Nextcloud server address is not allowed.",
  },
};

export class NextcloudLoginFlowError extends Error {
  readonly statusCode: number;
  readonly code: NextcloudLoginFlowErrorCode;

  constructor(code: NextcloudLoginFlowErrorCode) {
    super(FAILURES[code].message);
    this.name = "NextcloudLoginFlowError";
    this.statusCode = FAILURES[code].statusCode;
    this.code = code;
  }
}

/** The app name Nextcloud shows the member on the Login Flow approval page (it
 * uses the request's User-Agent as the device/app name). */
const NEXTCLOUD_USER_AGENT = "SourceWeft";

/** Nextcloud requires this header on every OCS API request. */
const OCS_API_REQUEST = "OCS-APIRequest";

/** A ceiling on the small JSON bodies these exchanges return; a larger body is a
 * misbehaving server and is rejected as invalid. */
export const MAX_LOGIN_FLOW_BYTES = 1024 * 1024;

/** The files user id is at most this many characters (matches the config
 * schema's `NEXTCLOUD_USER_ID_PATTERN`). */
export const MAX_FILES_USER_ID_LENGTH = 255;

export type NextcloudTransportLimits = {
  /** Per-request timeout, covering the headers and the capped body read. */
  timeoutMs: number;
  /** Largest response body read before the body is rejected as invalid. */
  maxBytes: number;
};

/** The host's endpoint-policy refusal is duck-typed: this package cannot import
 * backend code (mirrors the WebDAV dav-client check). */
function isEndpointNotAllowed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENDPOINT_NOT_ALLOWED"
  );
}

/** Marks an abort as this layer's timeout, so it maps to `UNREACHABLE`. */
class RequestTimeout {}

/** Rejects when the signal aborts, so a read that ignores it cannot hang. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new RequestTimeout());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestTimeout());
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

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failed cancel changes nothing.
  }
}

/** Reads at most `maxBytes` and throws `INVALID` the moment one more arrives, so
 * a hostile body is never fully read. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared.trim()) &&
    Number(declared.trim()) > maxBytes
  ) {
    await cancelBody(response);
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
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
  return new TextDecoder("utf-8").decode(out);
}

export type NextcloudResponse = { status: number; text: string };

export type NextcloudRequestOptions = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * One request through a credentialed fetch scope, with a per-request timeout and
 * a capped body read. Every transport failure becomes a fixed
 * {@link NextcloudLoginFlowError} that echoes nothing: a blocked address or a
 * cross-origin redirect (the scope refuses it) maps to
 * `NEXTCLOUD_BLOCKED_ENDPOINT`, and a network error or timeout to
 * `NEXTCLOUD_UNREACHABLE`. The caller interprets the HTTP status code. Redirects
 * are the injected scope's business (it follows a same-origin hop and refuses a
 * cross-origin one), so a credential never leaves the server's origin.
 */
export async function nextcloudRequest(
  scope: ConnectorPublicFetchScope,
  options: NextcloudRequestOptions,
  limits: NextcloudTransportLimits,
): Promise<NextcloudResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new RequestTimeout()),
    limits.timeoutMs,
  );
  try {
    const response = await scope.fetch(options.url, {
      method: options.method,
      headers: {
        "User-Agent": NEXTCLOUD_USER_AGENT,
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal,
    });
    const text = await readCapped(response, limits.maxBytes, controller.signal);
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof NextcloudLoginFlowError) throw error;
    if (isEndpointNotAllowed(error)) {
      throw new NextcloudLoginFlowError("NEXTCLOUD_BLOCKED_ENDPOINT");
    }
    throw new NextcloudLoginFlowError("NEXTCLOUD_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
}

/** The HTTP Basic credential for an OCS request. Built here only, never logged,
 * stored on an error or returned. */
export function basicAuth(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString(
    "base64",
  )}`;
}

/** Rejects a files user id that is empty, over-long, or carries a path separator
 * or a control character (it is encoded as a single DAV path segment). */
function sanitizeUserId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_FILES_USER_ID_LENGTH
  ) {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  if (/[\u0000-\u001F\u007F/]/.test(value)) {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  return value;
}

/**
 * Resolves the Nextcloud files user id (which can differ from the login name)
 * via the OCS `cloud/user` endpoint, authenticated with the freshly issued app
 * password. `server` is the normalised server base (no trailing slash). A 5xx or
 * 429 is unreachable; any other non-200, or a body without a usable `ocs.data.id`,
 * is invalid (never a raw 401 upstream).
 */
export async function resolveFilesUserId(
  scope: ConnectorPublicFetchScope,
  input: { server: string; loginName: string; appPassword: string },
  limits: NextcloudTransportLimits,
): Promise<string> {
  const { status, text } = await nextcloudRequest(
    scope,
    {
      method: "GET",
      url: `${input.server}/ocs/v1.php/cloud/user?format=json`,
      headers: {
        Authorization: basicAuth(input.loginName, input.appPassword),
        [OCS_API_REQUEST]: "true",
        Accept: "application/json",
      },
    },
    limits,
  );
  if (status === 429 || status >= 500) {
    throw new NextcloudLoginFlowError("NEXTCLOUD_UNREACHABLE");
  }
  if (status !== 200) {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  const id = (parsed as { ocs?: { data?: { id?: unknown } } })?.ocs?.data?.id;
  return sanitizeUserId(id);
}

/**
 * Best-effort revocation of an app password the provider issued: the OCS
 * `DELETE core/apppassword` with the credential. Throws on any failure so a
 * caller that wants best-effort behaviour (`discard`) wraps and swallows it.
 * `server` is the server base; a trailing slash is stripped.
 */
export async function deleteAppPassword(
  scope: ConnectorPublicFetchScope,
  input: { server: string; username: string; secret: string },
  limits: NextcloudTransportLimits,
): Promise<void> {
  const base = input.server.replace(/\/+$/, "");
  await nextcloudRequest(
    scope,
    {
      method: "DELETE",
      url: `${base}/ocs/v2.php/core/apppassword`,
      headers: {
        Authorization: basicAuth(input.username, input.secret),
        [OCS_API_REQUEST]: "true",
      },
    },
    limits,
  );
}

import type { ConnectorSyncReadinessResult } from "@sourceweft/contracts";
import { GhostError, type GhostErrorCode } from "./errors";

/**
 * An error shaped like the platform's `ConnectorError` (`statusCode`, `code`,
 * `message`), used at the adapter boundary. The package's own {@link GhostError}
 * carries an un-prefixed code and a `status`; here the code is re-prefixed
 * `GHOST_` so the orchestrator sees a namespaced, fixed-message error. The
 * message is always one of the package's fixed strings: it never echoes the
 * site address, the Content API key, an id or anything a site sent, and no
 * `cause` is ever carried across.
 */
export class GhostAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "GhostAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The fixed 400 for a selection-action request the adapter cannot accept. */
export function invalidRequestError(): GhostAdapterError {
  return new GhostAdapterError(
    400,
    "GHOST_INVALID_REQUEST",
    "The Ghost action request is not valid.",
  );
}

/** The fixed 400 for an action type this adapter does not implement. */
export function unsupportedActionError(): GhostAdapterError {
  return new GhostAdapterError(
    400,
    "GHOST_UNSUPPORTED_ACTION",
    "Unsupported Ghost action",
  );
}

/**
 * Crosses a Ghost-layer failure over the adapter boundary (discover, extract,
 * the selection actions and the credential identity; readiness uses
 * {@link readinessFailure} on the raw error): a {@link GhostError} keeps its
 * fixed status and message and takes the `GHOST_` prefix on its code. Anything
 * else (an item skip, an abort, a programming error) is rethrown untouched.
 *
 * `BAD_CREDENTIALS` is the reconnect condition, not a retryable failure: it
 * becomes a 422 `GHOST_REAUTH_REQUIRED`, whose `_REAUTH_REQUIRED` suffix the
 * orchestrator recognises to mark the account for reconnect (never a 401 that
 * could be read as a sign-out). Always throws.
 */
export function mapGhostError(error: unknown): never {
  if (error instanceof GhostError) {
    if (error.code === "BAD_CREDENTIALS") {
      throw new GhostAdapterError(422, "GHOST_REAUTH_REQUIRED", error.message);
    }
    throw new GhostAdapterError(
      error.status,
      `GHOST_${error.code}`,
      error.message,
    );
  }
  throw error;
}

/**
 * The readiness reason a not-ready result reports for each error code. A bad
 * key is the reconnect condition `reauth_required`; the rest map to the
 * closest member-facing reason. None of these strings carries site data.
 */
const READINESS_REASONS: Record<GhostErrorCode, string> = {
  SITE_URL_INVALID: "config_invalid",
  CONFIG_INVALID: "config_invalid",
  SITE_UNREACHABLE: "unreachable",
  NOT_A_GHOST_SITE: "not_a_ghost_site",
  BAD_CREDENTIALS: "reauth_required",
  BLOCKED_ENDPOINT: "blocked_endpoint",
  LINK_INVALID: "unreachable",
  RATE_LIMITED: "rate_limited",
  BAD_RESPONSE: "unreachable",
  TOO_LARGE: "unreachable",
};

/** A not-ready readiness result for a Ghost-layer error, or null when the
 * error is not one this adapter can explain (it then bubbles up). */
export function readinessFailure(
  error: unknown,
): ConnectorSyncReadinessResult | null {
  if (!(error instanceof GhostError)) return null;
  return {
    ready: false,
    reason: READINESS_REASONS[error.code],
    message: error.message,
  };
}

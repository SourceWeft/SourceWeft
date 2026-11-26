import type { ConnectorSyncReadinessResult } from "@sourceweft/contracts";
import { WordPressError, type WordPressErrorCode } from "./errors";

/**
 * An error shaped like the platform's `ConnectorError` (`statusCode`, `code`,
 * `message`), used at the adapter boundary. The package's own {@link WordPressError}
 * carries an un-prefixed code and a `status`; here the code is re-prefixed
 * `WORDPRESS_` so the orchestrator sees a namespaced, fixed-message error. The
 * message is always one of the package's fixed strings: it never echoes the site
 * address, a credential (the Application Password above all), an id or anything a
 * site sent, and no `cause` is ever carried across.
 */
export class WordPressAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WordPressAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The fixed 400 for a selection-action request the adapter cannot accept. */
export function invalidRequestError(): WordPressAdapterError {
  return new WordPressAdapterError(
    400,
    "WORDPRESS_INVALID_REQUEST",
    "The WordPress action request is not valid.",
  );
}

/** The fixed 400 for an action type this adapter does not implement. */
export function unsupportedActionError(): WordPressAdapterError {
  return new WordPressAdapterError(
    400,
    "WORDPRESS_UNSUPPORTED_ACTION",
    "Unsupported WordPress action",
  );
}

/**
 * Crosses a WordPress-layer failure over the adapter boundary: a
 * {@link WordPressError} keeps its own fixed status and message and takes the
 * `WORDPRESS_` prefix on its code (no cause is carried); anything else (an item
 * skip, a programming error) is rethrown untouched. Always throws.
 */
export function mapWordPressError(error: unknown): never {
  if (error instanceof WordPressError) {
    throw new WordPressAdapterError(
      error.status,
      `WORDPRESS_${error.code}`,
      error.message,
    );
  }
  throw error;
}

/**
 * The readiness reason a not-ready result reports for each error code (the web,
 * Task 9, turns these into message keys). `BAD_CREDENTIALS` is the reconnect
 * condition `reauth_required`; `INSUFFICIENT_PERMISSION` and `LOGIN_REQUIRED`
 * (whose copy suggests the login connector) keep their own reasons; the rest map
 * to the closest member-facing reason. None of these strings carries site data.
 */
const READINESS_REASONS: Record<WordPressErrorCode, string> = {
  SITE_URL_INVALID: "config_invalid",
  CONFIG_INVALID: "config_invalid",
  SITE_UNREACHABLE: "unreachable",
  NOT_A_WORDPRESS_SITE: "not_a_wordpress_site",
  REST_DISABLED: "rest_disabled",
  LOGIN_REQUIRED: "login_required",
  BAD_CREDENTIALS: "reauth_required",
  INSUFFICIENT_PERMISSION: "insufficient_permission",
  BLOCKED_ENDPOINT: "blocked_endpoint",
  LINK_HOST_MISMATCH: "unreachable",
  RATE_LIMITED: "rate_limited",
  BAD_RESPONSE: "unreachable",
  TOO_LARGE: "unreachable",
};

/** A not-ready readiness result for a WordPress-layer error, or null when the
 * error is not one this adapter can explain (it then bubbles up). */
export function readinessFailure(
  error: unknown,
): ConnectorSyncReadinessResult | null {
  if (!(error instanceof WordPressError)) return null;
  return {
    ready: false,
    reason: READINESS_REASONS[error.code],
    message: error.message,
  };
}

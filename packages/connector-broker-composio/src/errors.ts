export type ComposioBrokerErrorCode =
  | "COMPOSIO_AUTH" // 401/403 from Composio itself
  | "COMPOSIO_QUOTA" // plan limit reached (402 or Composio's quota error)
  | "COMPOSIO_CONNECTION_INACTIVE" // connected account is not ACTIVE / unknown to Composio
  | "COMPOSIO_UNAVAILABLE" // network error, timeout, 429 or 5xx from Composio
  | "COMPOSIO_REQUEST_FAILED"; // any other non-2xx from Composio

export class ComposioBrokerError extends Error {
  constructor(
    readonly code: ComposioBrokerErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ComposioBrokerError";
  }
}

// Composio's exact response bodies for a "quota exhausted" error and for a
// "connected account not found / not active" error are not documented on the
// pages saved for this task (custom-tools.md, proxy.md, manual-auth.md,
// auth.md — read 2026-11-15). This body-text heuristic is an unverified
// best guess, used only after HTTP status has not already classified the
// response; it will be confirmed against the real Composio service in
// Task 8 and may need to change then.
function bodyIndicatesQuotaExhausted(rawBody: string): boolean {
  return /quota|plan limit/i.test(rawBody);
}

function bodyIndicatesInactiveConnection(rawBody: string): boolean {
  return /no connected account|connected account[^.]*(not found|not active|inactive|unknown)/i.test(
    rawBody,
  );
}

/**
 * Classifies a non-2xx Composio response into a ComposioBrokerErrorCode.
 * HTTP status is authoritative where Composio's own semantics are
 * documented; the undocumented quota / inactive-connection cases fall back
 * to a body-text heuristic (see the comment above).
 */
export function classifyComposioError(
  status: number,
  rawBody: string,
): ComposioBrokerErrorCode {
  if (status === 401 || status === 403) return "COMPOSIO_AUTH";
  if (status === 402) return "COMPOSIO_QUOTA";
  if (status === 429 || status >= 500) return "COMPOSIO_UNAVAILABLE";
  if (bodyIndicatesQuotaExhausted(rawBody)) return "COMPOSIO_QUOTA";
  if (bodyIndicatesInactiveConnection(rawBody)) return "COMPOSIO_CONNECTION_INACTIVE";
  return "COMPOSIO_REQUEST_FAILED";
}

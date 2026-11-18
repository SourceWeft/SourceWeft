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

// Composio's error body is `{"error":{"slug":…,"message":…,"status":…}}`.
// Seen on the real service 2026-11-16: any call that names a connected
// account Composio does not hold (deleted or never created) answers HTTP 404
// with slug `ConnectedAccount_ResourceNotFound`. The slug decides; the
// message match below stays for a not-active account, whose body was not
// observed. The quota body was not observed either (the test project never
// reached its limit), so that match is still a best guess used only after
// the HTTP status has not classified the answer.
const INACTIVE_CONNECTION_SLUGS = new Set(["ConnectedAccount_ResourceNotFound"]);

function errorSlug(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { slug?: unknown } } | null;
    const slug = parsed?.error?.slug;
    return typeof slug === "string" ? slug : undefined;
  } catch {
    return undefined;
  }
}

function bodyIndicatesQuotaExhausted(rawBody: string): boolean {
  return /quota|plan limit/i.test(rawBody);
}

function bodyIndicatesInactiveConnection(rawBody: string): boolean {
  const slug = errorSlug(rawBody);
  if (slug !== undefined && INACTIVE_CONNECTION_SLUGS.has(slug)) return true;
  return /no connected account|connected account[^.]*(not found|not active|inactive|unknown)/i.test(
    rawBody,
  );
}

/**
 * Classifies a non-2xx Composio response into a ComposioBrokerErrorCode.
 * HTTP status is authoritative where Composio's own semantics are
 * documented; an unknown connected account is recognised by its error slug,
 * and the remaining quota / inactive-connection cases by body text (see the
 * comment above).
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

import type { ComposioBroker, ProxyInput } from "@sourceweft/connector-broker-composio";
import { ComposioBrokerError } from "@sourceweft/connector-broker-composio";

/**
 * Raised by a Gmail transport or by the Gmail request layer above it.
 * Defined here (rather than in `adapter.ts`) so both transports can throw it
 * without creating a circular import between `transport.ts` and
 * `adapter.ts`; `adapter.ts` re-exports it unchanged for its own callers.
 */
export class GmailAdapterError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailAdapterError";
  }
}

export type GmailTransportResponse = {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
};

export type GmailTransport = (
  url: string,
  credential: string,
  init: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<GmailTransportResponse>;

function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Talks to the Gmail REST API directly, authorizing with a bearer token
 * SourceWeft holds. The retry loop and HTTP-status-to-error mapping live in
 * `adapter.ts`'s `providerRequest`; this transport only performs one HTTP
 * attempt and reports what happened.
 */
export function createGoogleDirectTransport(fetcher: typeof fetch): GmailTransport {
  return async (url, credential, init) => {
    const response = await fetcher(url, {
      method: init.method,
      body: init.body,
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get("Retry-After"),
    );
    if (!response.ok) {
      return { status: response.status, body: undefined, retryAfterSeconds };
    }
    return { status: response.status, body: await response.json(), retryAfterSeconds };
  };
}

function readRetryAfterSeconds(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "retry-after") {
      return parseRetryAfterSeconds(value);
    }
  }
  return undefined;
}

/**
 * Talks to the Gmail REST API through Composio's proxy, authorizing with the
 * connected account Composio holds; SourceWeft never sees a Google token.
 * One attempt per call (the broker itself never retries); the mapping below
 * decides, for each `ComposioBrokerError`, whether `adapter.ts`'s retry loop
 * should see it as a retryable network-style failure or as a terminal
 * `GmailAdapterError` it must not retry.
 */
export function createComposioTransport(broker: ComposioBroker): GmailTransport {
  return async (url, credential, init) => {
    const { ownerRef, connectedAccountId } = decodeComposioCredential(credential);
    let result;
    try {
      result = await broker.proxy({
        connectedAccountId,
        ownerRef,
        url,
        method: (init.method as ProxyInput["method"] | undefined) ?? "GET",
        headers: init.headers,
        body: init.body !== undefined ? JSON.parse(init.body) : undefined,
      });
    } catch (error) {
      if (error instanceof ComposioBrokerError) {
        if (error.code === "COMPOSIO_CONNECTION_INACTIVE") {
          return { status: 401, body: undefined };
        }
        if (error.code === "COMPOSIO_UNAVAILABLE") {
          // Rethrown as-is (not a GmailAdapterError) so adapter.ts's
          // network-failure branch retries it, exactly like a direct
          // network failure against Google.
          throw error;
        }
        // COMPOSIO_AUTH, COMPOSIO_QUOTA, COMPOSIO_REQUEST_FAILED: Composio
        // itself is misconfigured or exhausted, not a transient network
        // condition, so this is reported once and never retried.
        throw new GmailAdapterError(
          503,
          "GMAIL_UNAVAILABLE",
          "Gmail is temporarily unavailable",
        );
      }
      throw error;
    }
    if (typeof result.status !== "number") {
      throw new GmailAdapterError(
        503,
        "GMAIL_UNAVAILABLE",
        "Gmail is temporarily unavailable",
      );
    }
    return {
      status: result.status,
      body: result.data,
      retryAfterSeconds: readRetryAfterSeconds(result.headers),
    };
  };
}

type ComposioCredential = { v: 1; owner: string; account: string };

export function encodeComposioCredential(input: {
  ownerRef: string;
  connectedAccountId: string;
}): string {
  const credential: ComposioCredential = {
    v: 1,
    owner: input.ownerRef,
    account: input.connectedAccountId,
  };
  return JSON.stringify(credential);
}

export function decodeComposioCredential(
  credential: string,
): { ownerRef: string; connectedAccountId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    parsed = null;
  }
  const record = parsed as Partial<ComposioCredential> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.v !== 1 ||
    typeof record.owner !== "string" ||
    typeof record.account !== "string"
  ) {
    throw new GmailAdapterError(
      401,
      "GMAIL_REAUTH_REQUIRED",
      "Gmail connection is invalid; reconnect Gmail",
    );
  }
  return { ownerRef: record.owner, connectedAccountId: record.account };
}

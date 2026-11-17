import type { OAuthTokenSet } from "@sourceweft/contracts";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30000;
/** The token endpoint gets a shorter budget than GraphQL: the platform
 * abandons a refresh after 20 seconds, and Linear's refresh tokens are
 * single-use, so a refresh that returns later than that would rotate the
 * token with nobody left to store it. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** Used when neither `Retry-After` nor `X-RateLimit-Requests-Reset` is
 * present on a rate-limited response. */
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;

export class LinearAdapterError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: { retryAfterSeconds: number },
  ) {
    super(message);
    this.name = "LinearAdapterError";
  }
}

type GraphqlErrorBody = {
  data?: unknown;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

type TokenResponseBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
};

/** `scope` is a string (split on spaces and commas) or an array (used as
 * given); either maps to `OAuthTokenSet.scopes`. */
function scopesFrom(scope: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(scope)) return scope;
  if (typeof scope === "string") {
    return scope
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return undefined;
}

/** `Retry-After` (seconds), else `X-RateLimit-Requests-Reset` (epoch ms,
 * converted to seconds from now), else the fixed default. Never throws on a
 * malformed header. */
function retryAfterSecondsFrom(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  const resetAtMs = response.headers.get("x-ratelimit-requests-reset");
  if (resetAtMs !== null) {
    const resetAt = Number(resetAtMs);
    if (Number.isFinite(resetAt)) {
      return Math.max(0, Math.round((resetAt - Date.now()) / 1000));
    }
  }
  return DEFAULT_RATE_LIMIT_RETRY_SECONDS;
}

function rateLimited(retryAfterSeconds: number): LinearAdapterError {
  return new LinearAdapterError(
    429,
    "LINEAR_RATE_LIMITED",
    `Linear rate limit reached; retry in ${retryAfterSeconds} seconds`,
    { retryAfterSeconds },
  );
}

function unavailable(): LinearAdapterError {
  return new LinearAdapterError(503, "LINEAR_UNAVAILABLE", "Linear is unavailable");
}

export type LinearClientOptions = {
  clientId: string;
  clientSecret: string;
  fetcher: typeof fetch;
};

export type LinearClient = ReturnType<typeof createLinearClient>;

export function createLinearClient(options: LinearClientOptions) {
  const { clientId, clientSecret, fetcher } = options;

  /** Every token-endpoint call (exchange and refresh). Network errors and
   * timeouts are normalized to `503 LINEAR_UNAVAILABLE`, same as a 5xx. */
  async function tokenRequest(params: URLSearchParams): Promise<OAuthTokenSet> {
    params.set("client_id", clientId);
    params.set("client_secret", clientSecret);
    let response: Response;
    try {
      response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        // A wrong deployment client secret (`invalid_client` /
        // `unauthorized_client`) is not the user's authorization failing:
        // treat it as unavailable so the platform keeps retrying instead of
        // marking every account as needing reauthorization. Only the `error`
        // field is read; the response body never enters a message.
        let errorCode: unknown;
        try {
          errorCode = ((await response.json()) as { error?: unknown }).error;
        } catch {
          errorCode = undefined;
        }
        if (errorCode === "invalid_client" || errorCode === "unauthorized_client") {
          throw unavailable();
        }
        throw new LinearAdapterError(400, "LINEAR_REAUTH_REQUIRED", "Linear reauthorization required");
      }
      if (response.status === 429) {
        throw rateLimited(retryAfterSecondsFrom(response));
      }
      if (response.status >= 500) {
        throw unavailable();
      }
      throw new LinearAdapterError(502, "LINEAR_REQUEST_FAILED", `Linear request failed (${response.status})`);
    }
    let payload: TokenResponseBody;
    try {
      payload = (await response.json()) as TokenResponseBody;
    } catch {
      throw unavailable();
    }
    // A 2xx with no usable access token is an upstream fault, never a stored
    // empty token.
    if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      throw unavailable();
    }
    return {
      accessToken: payload.access_token,
      // A refresh response may carry no refresh_token: the caller keeps
      // using the one it already stored.
      refreshToken: payload.refresh_token ?? undefined,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
      scopes: scopesFrom(payload.scope),
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
    /** Issues one GraphQL request and maps the response onto
     * `LinearAdapterError` (see the mapping table in the task brief).
     * `document` is always one of the constants in `documents.ts`; every
     * caller-supplied value travels only through `variables`. Returns
     * `data` on success. */
    async query<T>(token: string, document: string, variables: Record<string, unknown>): Promise<T> {
      let response: Response;
      try {
        response = await fetcher(GRAPHQL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw unavailable();
      }

      let body: GraphqlErrorBody | null = null;
      try {
        body = (await response.json()) as GraphqlErrorBody;
      } catch {
        body = null;
      }
      const firstError = body?.errors?.[0];
      const extensionCode = firstError?.extensions?.code;
      const errorMessage = firstError?.message ?? "";

      if (response.status === 401 || extensionCode === "AUTHENTICATION_ERROR") {
        throw new LinearAdapterError(401, "LINEAR_REAUTH_REQUIRED", "Linear reauthorization required");
      }
      if (response.status === 429 || extensionCode === "RATELIMITED") {
        throw rateLimited(retryAfterSecondsFrom(response));
      }
      if (
        response.status === 403 ||
        extensionCode === "FORBIDDEN" ||
        errorMessage.startsWith("Entity not found")
      ) {
        throw new LinearAdapterError(404, "LINEAR_NOT_FOUND", "Linear entity not found");
      }
      if (response.status >= 500) {
        throw unavailable();
      }
      if (!response.ok || (body?.errors && body.errors.length > 0)) {
        throw new LinearAdapterError(502, "LINEAR_REQUEST_FAILED", `Linear request failed (${response.status})`);
      }
      // A 2xx whose body cannot be parsed, or carries neither object-valued
      // `data` nor an `errors` array, is an upstream fault, not an answer:
      // `query` must never resolve `undefined`, so callers that dereference
      // `data` directly can rely on it.
      if (!body || typeof body.data !== "object" || body.data === null) {
        throw new LinearAdapterError(503, "LINEAR_UNAVAILABLE", `Linear request failed (${response.status})`);
      }
      return body.data as T;
    },
  };
}

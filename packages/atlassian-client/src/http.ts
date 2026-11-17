// The product-scoped request wrapper (`/ex/<product>/<cloudId>/...`) plus the
// OAuth constants Jira and Confluence both read verbatim (Global Constraints).

import { AtlassianApiError, mapApiError, unavailableError, type AtlassianErrorPrefix } from "./errors";

export type { AtlassianErrorPrefix } from "./errors";

export type AtlassianProduct = "jira" | "confluence";

export type AtlassianClientConfig = {
  clientId: string;
  clientSecret: string;
  errorPrefix: AtlassianErrorPrefix;
  fetcher?: typeof fetch;
};

export const ATLASSIAN_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const ATLASSIAN_AUTHORIZATION_PARAMS = {
  audience: "api.atlassian.com",
  prompt: "consent",
} as const;

/** Source for every cloud id check (connector config schema, selection ids, this
 * client). Anchored with `^`/`$` where it is used as a whole-string match. */
export const CLOUD_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLOUD_ID_REGEXP = new RegExp(`^${CLOUD_ID_PATTERN}$`);

const REQUEST_TIMEOUT_MS = 30000;
const API_BASE_URL = "https://api.atlassian.com";

export function isCloudId(value: string): boolean {
  return CLOUD_ID_REGEXP.test(value);
}

function productPrefix(product: AtlassianProduct): AtlassianErrorPrefix {
  return product === "confluence" ? "CONFLUENCE" : "JIRA";
}

/** Builds the per-site REST base URL for a product. Validates `cloudId` and
 * `path` itself (never trusts a caller-supplied id/path into a URL) using the
 * prefix for `product`, independent of any client config's `errorPrefix`. */
export function atlassianApiUrl(product: AtlassianProduct, cloudId: string, path: string): string {
  const prefix = productPrefix(product);
  if (!isCloudId(cloudId)) {
    throw new AtlassianApiError(400, `${prefix}_INVALID_REQUEST`, "Invalid Atlassian cloud id");
  }
  if (!path.startsWith("/")) {
    throw new AtlassianApiError(400, `${prefix}_INVALID_REQUEST`, "Invalid Atlassian request path");
  }
  return `${API_BASE_URL}/ex/${product}/${cloudId}${path}`;
}

/** Internal GET helper for the plain `api.atlassian.com` endpoints that are not
 * scoped to a product/site (accessible-resources, /me). Same timeout and error
 * mapping as `atlassianRequest`, kept private to this package. */
export async function atlassianApiGet(
  config: AtlassianClientConfig,
  path: string,
  accessToken: string,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${API_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError(config.errorPrefix);
  }
  if (!response.ok) {
    throw mapApiError(response, config.errorPrefix);
  }
  try {
    return await response.json();
  } catch {
    // A 2xx whose body cannot be parsed is an outage, not valid data.
    throw unavailableError(config.errorPrefix);
  }
}

export async function atlassianRequest<T>(
  config: AtlassianClientConfig,
  input: {
    accessToken: string;
    product: AtlassianProduct;
    cloudId: string;
    path: string;
    query?: Record<string, string | number | string[] | undefined>;
    method?: "GET" | "POST";
    body?: unknown;
  },
): Promise<T> {
  // Validates cloudId/path before any network call: a bad one throws
  // synchronously here and the fetcher below is never reached.
  const url = new URL(atlassianApiUrl(input.product, input.cloudId, input.path));
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    Accept: "application/json",
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const fetcher = config.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: input.method ?? "GET",
      headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError(config.errorPrefix);
  }
  if (!response.ok) {
    throw mapApiError(response, config.errorPrefix);
  }
  try {
    return (await response.json()) as T;
  } catch {
    // A 2xx whose body cannot be parsed is an outage, not valid data.
    throw unavailableError(config.errorPrefix);
  }
}

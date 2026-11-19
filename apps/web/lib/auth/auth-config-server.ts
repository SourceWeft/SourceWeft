import "server-only";

import { unstable_cache } from "next/cache";

import { internalApiBaseUrl } from "../internal-api-base-url";
import {
  FALLBACK_WEB_AUTH_PAGE_CONFIG,
  parseWebAuthPageConfig,
  type WebAuthPageConfig,
} from "./web-sign-in-methods";

const AUTH_CONFIG_REVALIDATE_SECONDS = 300;

const cachedAuthPageConfig = unstable_cache(
  async () => {
    // Server to server: inside a container the browser-facing API origin does
    // not resolve, so this must be the internal one.
    const response = await fetch(`${internalApiBaseUrl()}/v1/auth/config`);
    if (!response.ok) {
      throw new Error(`Auth config request failed: ${response.status}`);
    }
    return parseWebAuthPageConfig(await response.json());
  },
  ["auth-page-config"],
  { revalidate: AUTH_CONFIG_REVALIDATE_SECONDS },
);

/**
 * What the API tells the auth views, read from the server rather than
 * assumed:
 * - whether people must verify their address before signing in, which the API
 *   requires only where it can deliver mail; the views route on it (after
 *   sign-up: to "check your inbox", or straight into the product);
 * - whether Sign in with Apple is set up for the web.
 *
 * If the API cannot be asked, see {@link FALLBACK_WEB_AUTH_PAGE_CONFIG}.
 */
export async function resolveWebAuthPageConfig(): Promise<WebAuthPageConfig> {
  try {
    return await cachedAuthPageConfig();
  } catch {
    return FALLBACK_WEB_AUTH_PAGE_CONFIG;
  }
}

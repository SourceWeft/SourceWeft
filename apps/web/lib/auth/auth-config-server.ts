import "server-only";

import { unstable_cache } from "next/cache";

import { apiBaseUrl } from "../api-base-url";

const AUTH_CONFIG_REVALIDATE_SECONDS = 300;

const cachedRequireEmailVerification = unstable_cache(
  async () => {
    const response = await fetch(`${apiBaseUrl}/v1/auth/config`);
    if (!response.ok) {
      throw new Error(`Auth config request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      requireEmailVerification?: unknown;
    };
    return body.requireEmailVerification !== false;
  },
  ["auth-require-email-verification"],
  { revalidate: AUTH_CONFIG_REVALIDATE_SECONDS },
);

/**
 * Whether the API makes people verify their address before signing in — which
 * it does only where it can deliver mail. The auth views route on it (after
 * sign-up: to "check your inbox", or straight into the product), so it is read
 * from the server rather than assumed. If the API cannot be asked, assume it
 * does: the worst case is a "verify your email" page in front of someone who
 * could already sign in, never an unverified account let through.
 */
export async function resolveRequireEmailVerification(): Promise<boolean> {
  try {
    return await cachedRequireEmailVerification();
  } catch {
    return true;
  }
}

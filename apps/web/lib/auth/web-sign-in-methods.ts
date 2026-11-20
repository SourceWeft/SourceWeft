/** What the web auth views need from the API's `/v1/auth/config` answer. */
export type WebAuthPageConfig = {
  requireEmailVerification: boolean;
  /** The deployment set up Sign in with Apple for the web redirect flow. */
  appleSignIn: boolean;
};

/**
 * When the API cannot be asked: people are made to verify their address (the
 * worst case is a "verify your email" page in front of someone who could
 * already sign in) and Apple is not offered (a button for a provider the
 * server lacks would only fail).
 */
export const FALLBACK_WEB_AUTH_PAGE_CONFIG: WebAuthPageConfig = {
  requireEmailVerification: true,
  appleSignIn: false,
};

/** Reads the answer, trusting nothing about its shape. */
export function parseWebAuthPageConfig(body: unknown): WebAuthPageConfig {
  const record =
    body && typeof body === "object"
      ? (body as { requireEmailVerification?: unknown; webSignIn?: unknown })
      : {};
  const webSignIn =
    record.webSignIn && typeof record.webSignIn === "object"
      ? (record.webSignIn as { apple?: unknown })
      : {};
  return {
    requireEmailVerification: record.requireEmailVerification !== false,
    appleSignIn: webSignIn.apple === true,
  };
}

export type WebSocialProvider = "google" | "github" | "apple";

/**
 * The social sign-in buttons of the web auth views, which the desktop app
 * also signs in through. Google and GitHub are always offered; Apple only
 * when the server says it can complete the web redirect flow.
 */
export function webSocialProviders(input: {
  appleSignIn: boolean;
}): WebSocialProvider[] {
  return input.appleSignIn
    ? ["google", "github", "apple"]
    : ["google", "github"];
}

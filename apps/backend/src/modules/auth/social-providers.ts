import { createAppleClientSecret } from "./apple-tokens";

/**
 * The sign-in providers Better Auth is given, built from the deployment's auth
 * settings. Kept free of side effects so each combination can be tested.
 */
export type SocialProviderSettings = {
  googleSignInWebClientId: string;
  googleSignInWebClientSecret: string;
  googleOneTapClientId: string;
  googleMobileClientId: string;
  googleIosClientId: string;
  githubClientId: string;
  githubClientSecret: string;
  appleAppBundleId: string;
  appleServicesId: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKey: string;
};

function googleEnabled(settings: SocialProviderSettings) {
  return Boolean(
    settings.googleSignInWebClientId && settings.googleSignInWebClientSecret,
  );
}

/**
 * Every Google client whose ID tokens are accepted. The web client is first: it
 * is the one the browser redirect flow uses. One Tap, Android and iOS tokens
 * are verified against their own client ids and never choose the redirect
 * client.
 */
function googleClientIds(settings: SocialProviderSettings) {
  return Array.from(
    new Set(
      [
        settings.googleSignInWebClientId,
        settings.googleOneTapClientId,
        settings.googleMobileClientId,
        settings.googleIosClientId,
      ].filter(Boolean),
    ),
  );
}

export function buildSocialProviders(
  settings: SocialProviderSettings,
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};

  if (googleEnabled(settings)) {
    const clientIds = googleClientIds(settings);
    providers.google = {
      clientId:
        clientIds.length > 1 ? clientIds : settings.googleSignInWebClientId,
      clientSecret: settings.googleSignInWebClientSecret,
      prompt: "select_account",
    };
  }

  if (settings.githubClientId && settings.githubClientSecret) {
    providers.github = {
      clientId: settings.githubClientId,
      clientSecret: settings.githubClientSecret,
      scope: ["read:user", "user:email"],
    };
  }

  if (settings.appleServicesId) {
    // Web Sign in with Apple: the browser redirect flow runs as the Services
    // ID. When the iOS app is set up too, the same provider still accepts its
    // native identity tokens, whose audience is the bundle id. Both clients
    // share one Apple user id, so either sign-in reaches the same account.
    const servicesId = settings.appleServicesId;
    providers.apple = {
      clientId: servicesId,
      // Apple caps how long a client secret lives, so every token request
      // signs a fresh one rather than reusing one made at startup. Better
      // Auth reads this when it makes the request.
      get clientSecret() {
        return createAppleClientSecret({
          clientId: servicesId,
          teamId: settings.appleTeamId,
          keyId: settings.appleKeyId,
          privateKey: settings.applePrivateKey,
        });
      },
      ...(settings.appleAppBundleId
        ? { appBundleIdentifier: settings.appleAppBundleId }
        : {}),
    };
  } else if (settings.appleAppBundleId) {
    // Native Sign in with Apple only: the iOS app obtains an identity token and
    // Better Auth verifies it against Apple's keys, with the app's bundle id as
    // the audience. No client secret is configured, so the browser redirect
    // flow is not available for Apple and no page may offer it.
    providers.apple = {
      clientId: settings.appleAppBundleId,
      appBundleIdentifier: settings.appleAppBundleId,
    };
  }

  return providers;
}

/** What the native apps need to know to offer their own sign-in methods. */
export type NativeSignInConfig = {
  /** The iOS app may offer Sign in with Apple. */
  apple: boolean;
  /**
   * The Google client the iOS app signs in with, or null when Google sign-in
   * on iOS is not configured. It is only reported while the Google provider
   * itself is enabled, because its tokens could not be verified otherwise.
   */
  googleIosClientId: string | null;
};

export function nativeSignInConfig(
  settings: SocialProviderSettings,
): NativeSignInConfig {
  return {
    apple: Boolean(settings.appleAppBundleId),
    googleIosClientId:
      googleEnabled(settings) && settings.googleIosClientId
        ? settings.googleIosClientId
        : null,
  };
}

/** What the web sign-in page needs to know to offer its sign-in methods. */
export type WebSignInConfig = {
  /** The web page may offer Sign in with Apple (the redirect flow). */
  apple: boolean;
};

export function webSignInConfig(
  settings: SocialProviderSettings,
): WebSignInConfig {
  return { apple: Boolean(settings.appleServicesId) };
}

/**
 * Apple returns the web sign-in as a form POST from its own site
 * (`response_mode=form_post`), so Better Auth's origin check must trust that
 * origin for the callback. It is added only to Better Auth's trusted origins
 * when web Sign in with Apple is on, never to API CORS.
 */
export const APPLE_SIGN_IN_ORIGIN = "https://appleid.apple.com";

export function authTrustedOrigins(
  settings: SocialProviderSettings & { trustedOrigins: readonly string[] },
): string[] {
  const origins = [...settings.trustedOrigins];
  if (settings.appleServicesId && !origins.includes(APPLE_SIGN_IN_ORIGIN)) {
    origins.push(APPLE_SIGN_IN_ORIGIN);
  }
  return origins;
}

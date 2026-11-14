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

  if (settings.appleAppBundleId) {
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

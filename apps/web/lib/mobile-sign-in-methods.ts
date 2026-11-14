import { apiBaseUrl } from "./api-base-url";

/** `nativeSignIn` in the API's `/v1/auth/config` answer. */
export type NativeSignInConfig = {
  apple: boolean;
  googleIosClientId: string | null;
};

/** The sign-in methods the mobile sign-in view offers besides email. */
export type MobileSignInMethods = {
  apple: boolean;
  /** Null when Google is not offered; otherwise the client to sign in with. */
  google: { clientId: string } | null;
};

export const NO_MOBILE_SIGN_IN_METHODS: MobileSignInMethods = {
  apple: false,
  google: null,
};

/**
 * Which native sign-in methods this app offers.
 *
 * iOS: Sign in with Apple when the API accepts it, and Google only next to it,
 * with the iOS app's own Google client. The App Store requires an app that
 * offers a third-party sign-in to offer Sign in with Apple as well, so Google
 * alone is never shown there.
 *
 * Android: Google with the client this web build was configured with, as
 * before. Sign in with Apple is not available.
 */
export function resolveMobileSignInMethods(input: {
  platform: string;
  nativeSignIn: NativeSignInConfig | null;
  googleMobileClientId: string;
}): MobileSignInMethods {
  if (input.platform !== "ios") {
    return {
      apple: false,
      google: { clientId: input.googleMobileClientId },
    };
  }

  const apple = input.nativeSignIn?.apple === true;
  const googleIosClientId = input.nativeSignIn?.googleIosClientId;
  return {
    apple,
    google: apple && googleIosClientId ? { clientId: googleIosClientId } : null,
  };
}

/** Reads `nativeSignIn` from an auth config answer, trusting nothing about its shape. */
export function parseNativeSignInConfig(body: unknown): NativeSignInConfig {
  const value =
    body && typeof body === "object"
      ? (body as { nativeSignIn?: unknown }).nativeSignIn
      : undefined;
  const record =
    value && typeof value === "object"
      ? (value as { apple?: unknown; googleIosClientId?: unknown })
      : {};
  const clientId = record.googleIosClientId;
  return {
    apple: record.apple === true,
    googleIosClientId:
      typeof clientId === "string" && clientId.trim() ? clientId.trim() : null,
  };
}

export async function fetchNativeSignInConfig(
  signal?: AbortSignal,
): Promise<NativeSignInConfig> {
  const response = await fetch(`${apiBaseUrl}/v1/auth/config`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Auth config request failed: ${response.status}`);
  }
  return parseNativeSignInConfig(await response.json());
}

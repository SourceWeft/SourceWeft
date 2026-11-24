"use client";

import { authClient } from "./auth-client";
import { nativeBridge } from "./native-bridge";

type GoogleAuthModule = {
  signIn: (options: {
    clientId: string;
    scopes?: string[];
    flowType?: "native" | "web";
  }) => Promise<{
    accessToken?: string;
    expiresAt?: number;
    idToken?: string;
    refreshToken?: string;
  }>;
};

function isCancelledGoogleSignIn(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return /cancelled|canceled|user.*closed|activity is cancelled/i.test(message);
}

async function loadGoogleAuthModule() {
  return import("@choochmeque/tauri-plugin-google-auth-api") as Promise<GoogleAuthModule>;
}

/**
 * Signs in with the native Google flow. `clientId` is the OAuth client of the
 * platform the app runs on: the iOS app has its own, Android uses the one this
 * web build was configured with.
 */
export async function signInWithMobileGoogle(clientId: string) {
  if (!clientId) {
    throw new Error("Google sign-in is not configured for this mobile build.");
  }

  let googleAuth: GoogleAuthModule;
  try {
    googleAuth = await loadGoogleAuthModule();
  } catch {
    throw new Error("Google sign-in is not available in this build.");
  }

  const tokens = await googleAuth.signIn({
    clientId,
    scopes: ["openid", "email", "profile"],
    flowType: "native",
  });

  if (!tokens.idToken) {
    throw new Error("Google did not return an ID token.");
  }

  const result = await authClient.signIn.social({
    provider: "google",
    callbackURL: "/dashboard",
    idToken: {
      token: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  });

  const resultError = (result as { error?: { message?: string | null } | null })
    .error;
  if (resultError?.message) {
    throw new Error(resultError.message);
  }

  return result;
}

/**
 * The message to show for a failed Google sign-in, or null when the person
 * cancelled it. The Google SDK's own errors describe app configuration
 * ("…is not configured in Info.plist") and mean nothing to the person, so they
 * go to the console and the person sees one plain sentence.
 */
export function getMobileGoogleSignInError(error: unknown) {
  if (isCancelledGoogleSignIn(error)) {
    return null;
  }

  console.warn("[mobile sign-in] Google sign-in failed", error);
  // The web view's console cannot be read on a phone; the device log can.
  void nativeBridge
    .logSignInFailure("google", describeError(error))
    .catch(() => undefined);
  return "Unable to sign in with Google. Try again or use email.";
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

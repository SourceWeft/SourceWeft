"use client";

import { authClient } from "./auth-client";

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

function resolveMobileGoogleClientId() {
  return process.env.NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID?.trim() || "";
}

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
  return import(
    "@choochmeque/tauri-plugin-google-auth-api"
  ) as Promise<GoogleAuthModule>;
}

export function isMobileGoogleSignInConfigured() {
  return Boolean(resolveMobileGoogleClientId());
}

export async function signInWithMobileGoogle() {
  const clientId = resolveMobileGoogleClientId();
  if (!clientId) {
    throw new Error(
      "Google sign-in is not configured for this mobile build.",
    );
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

export function getMobileGoogleSignInError(error: unknown) {
  if (isCancelledGoogleSignIn(error)) {
    return null;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Unable to sign in with Google. Try again or use email.";
}

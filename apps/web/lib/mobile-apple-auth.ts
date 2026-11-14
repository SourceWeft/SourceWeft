"use client";

import { authClient } from "./auth-client";
import { nativeBridge } from "./native-bridge";

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * The nonce pair for one sign-in. Apple copies `hashedNonce` into the identity
 * token; the API receives `nonce` and accepts the token only if its SHA-256
 * (hex) is the value in the token. A token issued for another request, or
 * replayed from elsewhere, therefore does not sign anyone in.
 */
export async function createAppleNonce() {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(nonce),
  );
  return { nonce, hashedNonce: toHex(new Uint8Array(digest)) };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function isCancelledAppleSignIn(error: unknown) {
  return /cancell?ed/i.test(errorMessage(error));
}

export async function signInWithMobileApple() {
  const { nonce, hashedNonce } = await createAppleNonce();
  const credential = await nativeBridge.signInWithApple(hashedNonce);

  if (!credential?.identityToken) {
    throw new Error("Apple did not return an identity token.");
  }

  // Apple gives the name only the first time a person authorizes the app, and
  // never puts it in the token, so it is passed along when it is there.
  const hasName = Boolean(credential.givenName || credential.familyName);
  const result = await authClient.signIn.social({
    provider: "apple",
    callbackURL: "/dashboard",
    idToken: {
      token: credential.identityToken,
      nonce,
      ...(hasName
        ? {
            user: {
              name: {
                firstName: credential.givenName ?? "",
                lastName: credential.familyName ?? "",
              },
            },
          }
        : {}),
    },
  });

  const resultError = (result as { error?: { message?: string | null } | null })
    .error;
  if (resultError?.message) {
    throw new Error(resultError.message);
  }

  return result;
}

/** The message to show for a failed Apple sign-in, or null when the person cancelled it. */
export function getMobileAppleSignInError(error: unknown) {
  if (isCancelledAppleSignIn(error)) {
    return null;
  }

  return (
    errorMessage(error).trim() ||
    "Unable to sign in with Apple. Try again or use email."
  );
}

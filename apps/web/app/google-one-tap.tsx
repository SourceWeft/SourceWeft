"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { authClient } from "../lib/auth-client";
import { resolveGoogleOneTapConfig } from "../lib/google-one-tap-config";

const ONE_TAP_PATHS = new Set(["/", "/auth/sign-in"]);
const googleOneTapConfig = resolveGoogleOneTapConfig();

type SessionData = {
  session?: unknown;
  user?: unknown;
} | null;

function hasActiveSession(data: SessionData | undefined) {
  return Boolean(data?.session || data?.user);
}

function shouldIgnoreOneTapError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message)
        : typeof error === "string"
          ? error
          : "";

  return /(cancel|close|dismiss|skip|moment|notallowed|suppressed|unavailable|fedcm)/i.test(
    message,
  );
}

function resolveCallbackURL(redirectTo: string | null) {
  if (
    redirectTo &&
    redirectTo.startsWith("/") &&
    !redirectTo.startsWith("//") &&
    !redirectTo.includes("\\")
  ) {
    return redirectTo;
  }

  return "/dashboard";
}

export function GoogleOneTap() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const promptedPathRef = useRef<string | null>(null);
  const { data, isPending } = authClient.useSession();
  const isSignedIn = hasActiveSession(data as SessionData | undefined);
  const callbackURL = useMemo(
    () => resolveCallbackURL(searchParams.get("redirectTo")),
    [searchParams],
  );

  useEffect(() => {
    if (!googleOneTapConfig.enabled) {
      return;
    }

    if (!googleOneTapConfig.clientId) {
      return;
    }

    if (!pathname || !ONE_TAP_PATHS.has(pathname)) {
      return;
    }

    if (isPending || isSignedIn) {
      return;
    }

    if (promptedPathRef.current === pathname) {
      return;
    }

    if (typeof authClient.oneTap !== "function") {
      return;
    }

    promptedPathRef.current = pathname;
    void (async () => {
      await authClient.oneTap({
        callbackURL,
        cancelOnTapOutside: false,
        fetchOptions: {
          credentials: "include",
        },
      });
    })().catch((error: unknown) => {
      promptedPathRef.current = null;
      if (shouldIgnoreOneTapError(error)) {
        return;
      }

      console.error("[Google One Tap] prompt failed", error);
    });
  }, [callbackURL, isPending, isSignedIn, pathname]);

  return null;
}

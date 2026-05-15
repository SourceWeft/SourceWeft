"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client";
import { resolveGoogleOneTapConfig } from "../lib/google-one-tap-config";

const ONE_TAP_PATHS = new Set(["/", "/auth/sign-in"]);
const googleOneTapConfig = resolveGoogleOneTapConfig();

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

export function GoogleOneTap() {
  const pathname = usePathname();
  const promptedPathRef = useRef<string | null>(null);

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

    if (promptedPathRef.current === pathname) {
      return;
    }

    if (typeof authClient.oneTap !== "function") {
      return;
    }

    promptedPathRef.current = pathname;
    void authClient.oneTap({
      callbackURL: "/dashboard",
      cancelOnTapOutside: false,
      fetchOptions: {
        credentials: "include",
      },
    }).catch((error: unknown) => {
      promptedPathRef.current = null;
      if (shouldIgnoreOneTapError(error)) {
        return;
      }

      console.error("[Google One Tap] prompt failed", error);
    });
  }, [pathname]);

  return null;
}

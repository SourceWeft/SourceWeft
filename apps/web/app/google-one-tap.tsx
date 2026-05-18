"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "../lib/auth-client";
import { apiBaseUrl } from "../lib/api-base-url";
import { resolveGoogleOneTapConfig } from "../lib/google-one-tap-config";

const ONE_TAP_PATHS = new Set(["/", "/auth/sign-in"]);
const SESSION_CONFIRM_ATTEMPTS = 3;
const SESSION_CONFIRM_DELAY_MS = 250;
const googleOneTapConfig = resolveGoogleOneTapConfig();

type SessionData = {
  session?: unknown;
  user?: unknown;
} | null;

type SessionResult = {
  data?: SessionData;
  session?: unknown;
  user?: unknown;
} | null;

type AuthRuntimeConfig = {
  oneTapEnabled?: boolean;
};

function hasActiveSession(data: SessionData | undefined) {
  return Boolean(data?.session || data?.user);
}

function hasActiveSessionResult(result: unknown) {
  const sessionResult = result as SessionResult | undefined;
  return Boolean(
    sessionResult?.data?.session ||
      sessionResult?.data?.user ||
      sessionResult?.session ||
      sessionResult?.user,
  );
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchAuthRuntimeConfig(signal: AbortSignal) {
  const response = await fetch(`${apiBaseUrl}/v1/auth/config`, {
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Auth config request failed: ${response.status}`);
  }

  return (await response.json()) as AuthRuntimeConfig;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const promptedPathRef = useRef<string | null>(null);
  const [runtimeOneTapEnabled, setRuntimeOneTapEnabled] = useState(false);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const { data, isPending, refetch } = authClient.useSession();
  const isSignedIn = hasActiveSession(data as SessionData | undefined);
  const callbackURL = useMemo(
    () => resolveCallbackURL(searchParams.get("redirectTo")),
    [searchParams],
  );

  useEffect(() => {
    if (!googleOneTapConfig.enabled) {
      setRuntimeOneTapEnabled(false);
      setRuntimeConfigLoaded(true);
      return;
    }

    if (!googleOneTapConfig.clientId) {
      setRuntimeOneTapEnabled(false);
      setRuntimeConfigLoaded(true);
      return;
    }

    const controller = new AbortController();

    void fetchAuthRuntimeConfig(controller.signal)
      .then((config) => {
        setRuntimeOneTapEnabled(Boolean(config.oneTapEnabled));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setRuntimeOneTapEnabled(false);
        console.error("[Google One Tap] failed to load auth config", error);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setRuntimeConfigLoaded(true);
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!runtimeConfigLoaded || !runtimeOneTapEnabled) {
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
      let callbackCompleted = false;

      await authClient.oneTap({
        cancelOnTapOutside: false,
        fetchOptions: {
          credentials: "include",
          onSuccess: () => {
            callbackCompleted = true;
          },
        },
      });

      if (!callbackCompleted) {
        return;
      }

      let confirmed = false;
      for (let attempt = 0; attempt < SESSION_CONFIRM_ATTEMPTS; attempt += 1) {
        const session = await authClient.getSession({
          query: {
            disableCookieCache: true,
          },
        });
        confirmed = hasActiveSessionResult(session);

        if (confirmed) {
          await refetch({
            query: {
              disableCookieCache: true,
            },
          });
          router.replace(callbackURL);
          router.refresh();
          return;
        }

        if (attempt < SESSION_CONFIRM_ATTEMPTS - 1) {
          await delay(SESSION_CONFIRM_DELAY_MS);
        }
      }

      if (!confirmed) {
        console.error(
          "[Google One Tap] sign-in callback completed, but no session was visible.",
        );
      }
    })().catch((error: unknown) => {
      promptedPathRef.current = null;
      if (shouldIgnoreOneTapError(error)) {
        return;
      }

      console.error("[Google One Tap] prompt failed", error);
    });
  }, [
    callbackURL,
    isPending,
    isSignedIn,
    pathname,
    refetch,
    router,
    runtimeConfigLoaded,
    runtimeOneTapEnabled,
  ]);

  return null;
}

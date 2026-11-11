"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner";
import { recordAuthIntent } from "../lib/analytics/auth-intent";
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

/**
 * Covers the page from the moment Google hands back a credential until the
 * signed-in destination is on screen. Without it the prompt closes and nothing
 * moves for the length of the callback, the session confirmation and the route
 * navigation, while the sign-in form underneath stays live.
 */
function SigningInOverlay({ label }: { label: string }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Take focus off whatever control had it so Enter/Space cannot start a
    // second sign-in underneath the overlay.
    overlayRef.current?.focus();
  }, []);

  function keepFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
    }
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-labelledby="google-one-tap-signing-in"
      tabIndex={-1}
      onKeyDown={keepFocus}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/70 outline-none backdrop-blur-sm animate-in fade-in-0 duration-150"
    >
      <div className="flex items-center gap-3 rounded-lg border bg-background px-5 py-4 shadow-lg">
        <Spinner aria-hidden="true" className="size-5" />
        <p
          id="google-one-tap-signing-in"
          aria-live="polite"
          className="text-sm font-medium text-foreground"
        >
          {label}
        </p>
      </div>
    </div>
  );
}

export function GoogleOneTap() {
  const t = useTranslations("authPages.oneTap");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const promptedPathRef = useRef<string | null>(null);
  const [runtimeOneTapEnabled, setRuntimeOneTapEnabled] = useState(false);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [, startRedirect] = useTransition();
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
    let credentialReceived = false;
    let failureReported = false;

    const reportFailure = (message: string, error: unknown) => {
      if (failureReported) {
        return;
      }

      failureReported = true;
      console.error("[Google One Tap] sign-in failed", error);
      setSigningIn(false);
      toast.error(message);
    };

    const finishSignIn = async () => {
      for (let attempt = 0; attempt < SESSION_CONFIRM_ATTEMPTS; attempt += 1) {
        const session = await authClient.getSession({
          query: {
            disableCookieCache: true,
          },
        });

        if (hasActiveSessionResult(session)) {
          // `useSession` catches up beside the navigation, not ahead of it:
          // awaiting it here would spend a second session round trip before
          // the navigation even starts. Until it lands the hook reports
          // pending, which the destination already treats as "still loading".
          void refetch({
            query: {
              disableCookieCache: true,
            },
          });
          // The state update rides the same transition as the navigation, so
          // the overlay stays up until the destination has rendered.
          startRedirect(() => {
            router.replace(callbackURL);
            router.refresh();
            setSigningIn(false);
          });
          return;
        }

        if (attempt < SESSION_CONFIRM_ATTEMPTS - 1) {
          await delay(SESSION_CONFIRM_DELAY_MS);
        }
      }

      reportFailure(
        t("noSession"),
        new Error("Callback completed, but no session was visible."),
      );
    };

    // The rest of sign-in is driven from the callback request's own hooks, not
    // from this promise: Google reports `credential_returned` as a dismissal,
    // which can settle the prompt before the callback request has finished.
    void authClient
      .oneTap({
        cancelOnTapOutside: false,
        fetchOptions: {
          credentials: "include",
          onRequest: () => {
            credentialReceived = true;
            setSigningIn(true);
          },
          onError: (context: { error: unknown }) => {
            reportFailure(t("failed"), context.error);
          },
          onSuccess: () => {
            recordAuthIntent("google_one_tap");
            void finishSignIn().catch((error: unknown) => {
              reportFailure(t("failed"), error);
            });
          },
        },
      })
      .catch((error: unknown) => {
        promptedPathRef.current = null;
        if (credentialReceived) {
          reportFailure(t("failed"), error);
          return;
        }

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
    t,
  ]);

  return signingIn ? <SigningInOverlay label={t("signingIn")} /> : null;
}

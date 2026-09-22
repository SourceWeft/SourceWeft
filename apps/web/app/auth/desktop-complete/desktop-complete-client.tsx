"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { trackAuthError, trackLogin } from "../../../lib/analytics-events";
import { authClient } from "../../../lib/auth-client";
import { buildDesktopCompleteDeepLink } from "../../../lib/desktop-auth";
import { apiBaseUrl } from "../../../lib/sdk";

type CompleteState =
  | { kind: "loading"; text: string }
  | { kind: "ready"; deepLink: string }
  | { kind: "expired"; text: string };

function getMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }

  return fallback;
}

function buildSignInUrl(state: string) {
  const url = new URL("/auth/sign-in", window.location.origin);
  url.searchParams.set("desktop", "1");
  url.searchParams.set("redirectTo", `/auth/desktop-complete?state=${state}`);
  return url.toString();
}

async function completeDesktopPollingAuth(input: {
  state: string;
  token: string;
  completionFailedMessage: string;
}) {
  const response = await fetch(`${apiBaseUrl}/v1/desktop-auth/complete`, {
    body: JSON.stringify({ state: input.state, token: input.token }),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message || input.completionFailedMessage);
  }
}

export function DesktopAuthCompleteClient() {
  const t = useTranslations("authPages.desktopComplete");
  const [state, setState] = useState<CompleteState>({
    kind: "loading",
    text: t("initialStatus"),
  });

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      const search = new URLSearchParams(window.location.search);
      const desktopState = search.get("state");
      if (!desktopState) {
        setState({
          kind: "expired",
          text: t("missingState"),
        });
        return;
      }

      try {
        const session = await authClient.getSession();
        if (cancelled) {
          return;
        }

        if (!session.data?.session) {
          trackAuthError({
            action: "login",
            method: "desktop",
            surface: "desktop",
          });
          window.location.replace(buildSignInUrl(desktopState));
          return;
        }

        const result = await authClient.oneTimeToken.generate();
        const token = result.data?.token;
        if (result.error || !token) {
          throw new Error(result.error?.message || t("tokenMissing"));
        }

        await completeDesktopPollingAuth({
          state: desktopState,
          token,
          completionFailedMessage: t("completionFailed"),
        });

        const nextDeepLink = buildDesktopCompleteDeepLink({
          state: desktopState,
          token,
        });
        if (!cancelled) {
          trackLogin("desktop");
          setState({ kind: "ready", deepLink: nextDeepLink });
        }
        window.location.href = nextDeepLink;
      } catch (value) {
        if (!cancelled) {
          trackAuthError({
            action: "login",
            method: "desktop",
            surface: "desktop",
          });
          setState({
            kind: "expired",
            text: getMessage(value, t("genericFailure")),
          });
        }
      }
    }

    void complete();

    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">
          {t("title")}
        </h1>
        <p className="text-sm text-slate-600">{t("description")}</p>
        {state.kind === "loading" && (
          <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
            {state.text}
          </p>
        )}
        {state.kind === "expired" && (
          <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">
            {state.text}
          </p>
        )}
        {state.kind === "ready" && (
          <a
            className="inline-flex text-sm font-medium text-slate-900 underline underline-offset-4"
            href={state.deepLink}
          >
            {t("openDesktopApp")}
          </a>
        )}
      </section>
    </main>
  );
}

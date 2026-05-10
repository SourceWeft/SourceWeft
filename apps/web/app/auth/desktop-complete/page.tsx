"use client";

import { useEffect, useState } from "react";
import { authClient } from "../../../lib/auth-client";
import { apiBaseUrl } from "../../../lib/sdk";
import { buildDesktopCompleteDeepLink } from "../../../lib/desktop-auth";

type CompleteState =
  | { kind: "loading"; text: string }
  | { kind: "ready"; deepLink: string }
  | { kind: "expired"; text: string };

function getMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }

  return "Unable to complete desktop sign-in.";
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
}) {
  const response = await fetch(`${apiBaseUrl}/v1/desktop-auth/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message || "Desktop sign-in completion failed.");
  }
}

export default function DesktopAuthCompletePage() {
  const [state, setState] = useState<CompleteState>({
    kind: "loading",
    text: "Returning to SourceWeft.",
  });

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      const search = new URLSearchParams(window.location.search);
      const desktopState = search.get("state");
      if (!desktopState) {
        setState({
          kind: "expired",
          text: "This desktop sign-in link is missing its state. Start sign-in again from the SourceWeft desktop app.",
        });
        return;
      }

      try {
        const session = await authClient.getSession();
        if (cancelled) {
          return;
        }

        if (!session.data?.session) {
          window.location.replace(buildSignInUrl(desktopState));
          return;
        }

        const result = await authClient.oneTimeToken.generate();
        const token = result.data?.token;
        if (result.error || !token) {
          throw new Error(
            result.error?.message || "Desktop sign-in token was not returned.",
          );
        }

        await completeDesktopPollingAuth({
          state: desktopState,
          token,
        });

        const nextDeepLink = buildDesktopCompleteDeepLink({
          token,
          state: desktopState,
        });
        if (!cancelled) {
          setState({ kind: "ready", deepLink: nextDeepLink });
        }
        window.location.href = nextDeepLink;
      } catch (value) {
        if (!cancelled) {
          setState({
            kind: "expired",
            text: getMessage(value),
          });
        }
      }
    }

    void complete();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <section className="w-full space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">
          Returning to SourceWeft
        </h1>
        <p className="text-sm text-slate-600">
          Finish sign-in in the SourceWeft desktop app.
        </p>
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
            Open SourceWeft desktop
          </a>
        )}
      </section>
    </main>
  );
}

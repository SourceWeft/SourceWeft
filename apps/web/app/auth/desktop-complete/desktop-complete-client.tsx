"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RotateCw, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sourceweft/ui-web/components/ui/card";
import { Logo } from "@sourceweft/ui-web/logo";
import { authClient } from "../../../lib/auth-client";
import {
  buildDesktopSignInPath,
  createDesktopHandoffLink,
  openDesktopDeepLink,
} from "../../../lib/desktop-auth";

type SessionUser = {
  email?: string | null;
  name?: string | null;
};

type CompleteState =
  | { kind: "loading" }
  | { kind: "confirm"; user: SessionUser; sent: boolean }
  | { kind: "error"; text: string };

function getInitials(user: SessionUser) {
  const value = user.name || user.email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function getMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The browser side of desktop sign-in. It shows who is signed in and hands a
 * one-time token to the desktop app only when that person clicks to open it,
 * so following a link to this page never issues a token by itself. The token
 * travels only through the `sourceweft://` deep link to the app on this
 * machine, which accepts it only for the sign-in it started.
 */
export function DesktopAuthCompleteClient() {
  const t = useTranslations("authPages.desktopComplete");
  const [desktopState, setDesktopState] = useState<string | null>(null);
  const [view, setView] = useState<CompleteState>({ kind: "loading" });
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      const state = new URLSearchParams(window.location.search).get("state");
      if (!state) {
        setView({ kind: "error", text: t("missingState") });
        return;
      }

      const session = await authClient.getSession();
      if (cancelled) {
        return;
      }

      if (!session.data?.session) {
        window.location.replace(buildDesktopSignInPath(state));
        return;
      }

      setDesktopState(state);
      setView({
        kind: "confirm",
        user: session.data.user ?? {},
        sent: false,
      });
    }

    void loadSession().catch((error: unknown) => {
      if (!cancelled) {
        setView({ kind: "error", text: getMessage(error, t("genericFailure")) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function openDesktop() {
    if (!desktopState || view.kind !== "confirm") {
      return;
    }

    setIsBusy(true);
    setMessage(null);
    try {
      const deepLink = await createDesktopHandoffLink(desktopState);
      setView({ ...view, sent: true });
      openDesktopDeepLink(deepLink);
    } catch (error) {
      setMessage(getMessage(error, t("genericFailure")));
    } finally {
      setIsBusy(false);
    }
  }

  async function switchAccount() {
    if (!desktopState) {
      return;
    }

    setIsBusy(true);
    try {
      await authClient.signOut();
      window.location.replace(buildDesktopSignInPath(desktopState));
    } catch (error) {
      setIsBusy(false);
      setMessage(getMessage(error, t("genericFailure")));
    }
  }

  if (view.kind === "loading") {
    return <div className="min-h-40 w-full max-w-md" />;
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-6">
      <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
        <CardHeader className="gap-4">
          <div className="flex items-center gap-3">
            <Logo className="h-10 w-10 rounded-lg" />
            <div>
              <CardTitle className="text-lg">{t("title")}</CardTitle>
              <CardDescription className="mt-1">
                {t("description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {view.kind === "error" ? (
            <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {view.text}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background text-sm font-semibold text-foreground ring-1 ring-border">
                  {getInitials(view.user) || <UserRound className="h-4 w-4" />}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {view.user.name || t("fallbackName")}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {view.user.email || t("fallbackEmail")}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Button
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => void openDesktop()}
                  size="lg"
                  type="button"
                >
                  {view.sent ? <RotateCw /> : <ExternalLink />}
                  {view.sent ? t("openDesktopAppAgain") : t("openDesktopApp")}
                </Button>
                <Button
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => void switchAccount()}
                  type="button"
                  variant="ghost"
                >
                  {t("useAnotherAccount")}
                </Button>
              </div>

              <p className="text-sm leading-6 text-muted-foreground">
                {view.sent ? t("sentHint") : t("confirmHint")}
              </p>

              {message && (
                <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {message}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

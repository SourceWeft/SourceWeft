"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, RotateCw } from "lucide-react";
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
import {
  buildDesktopWebAuthUrl,
  createDesktopAuthState,
  getPendingDesktopAuth,
  setPendingDesktopAuth,
} from "../../../lib/desktop-auth";
import { desktopBridge } from "../../../lib/desktop-bridge";

type DesktopLoginStatus = "idle" | "opening" | "waiting" | "error";

function describePath(path: string, t: ReturnType<typeof useTranslations>) {
  if (path === "sign-up") {
    return t("describeSignUp");
  }

  if (path === "forgot-password" || path === "reset-password") {
    return t("describeRecovery");
  }

  return t("describeDefault");
}

// The browser hands the sign-in back only through the `sourceweft://` deep
// link, which `DesktopAuthListener` picks up; this view just starts sign-in
// and waits for it.
export function DesktopLoginView({ path }: { path: string }) {
  const t = useTranslations("authPages.desktopLogin");
  const [status, setStatus] = useState<DesktopLoginStatus>("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const authPath = useMemo(() => `/auth/${path}`, [path]);

  useEffect(() => {
    const pendingAuth = getPendingDesktopAuth();
    if (pendingAuth.loginUrl && pendingAuth.state) {
      setLoginUrl(pendingAuth.loginUrl);
      setStatus("waiting");
    }
  }, []);

  useEffect(() => {
    if (status !== "waiting") {
      return;
    }

    const { expiresAt } = getPendingDesktopAuth();
    if (!expiresAt) {
      return;
    }

    const timeoutId = setTimeout(() => {
      // Reading it again drops the expired sign-in from storage.
      getPendingDesktopAuth();
      setStatus("idle");
      setLoginUrl(null);
      setMessage(t("expiredMessage"));
    }, Math.max(expiresAt - Date.now(), 0));

    return () => clearTimeout(timeoutId);
  }, [status, t]);

  async function openLogin(reusePending = false) {
    // Reopen only the sign-in that is still pending; once it has expired its
    // link is useless, so start a new one with a new state.
    const pendingAuth = getPendingDesktopAuth();
    const reused =
      reusePending && pendingAuth.state && pendingAuth.loginUrl
        ? { loginUrl: pendingAuth.loginUrl, state: pendingAuth.state }
        : null;
    const nextState = reused?.state ?? createDesktopAuthState();
    const nextLoginUrl =
      reused?.loginUrl ??
      buildDesktopWebAuthUrl({
        path: authPath,
        search:
          typeof window === "undefined" ? undefined : window.location.search,
        state: nextState,
      });

    setStatus("opening");
    setMessage(null);
    setCopied(false);

    try {
      if (!reused) {
        setPendingDesktopAuth({ loginUrl: nextLoginUrl, state: nextState });
      }
      setLoginUrl(nextLoginUrl);
      await desktopBridge.openExternalUrl(nextLoginUrl);
      setStatus("waiting");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : t("openBrowserFailed"),
      );
    }
  }

  async function copyLoginLink() {
    const link = loginUrl;
    if (!link || typeof navigator === "undefined" || !navigator.clipboard) {
      setMessage(t("noLoginLink"));
      return;
    }

    await navigator.clipboard.writeText(link);
    setCopied(true);
    setMessage(t("loginLinkCopied"));
  }

  const isOpening = status === "opening";
  const isWaiting = status === "waiting";

  return (
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
        <p className="text-sm leading-6 text-muted-foreground">
          {describePath(path, t)}
        </p>

        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={isOpening}
            onClick={() => void openLogin()}
            size="lg"
            type="button"
          >
            <ExternalLink />
            {isWaiting ? t("openBrowserAgain") : t("signInWithBrowser")}
          </Button>

          {loginUrl && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                disabled={isOpening}
                onClick={() => void openLogin(true)}
                type="button"
                variant="outline"
              >
                <RotateCw />
                {t("reopen")}
              </Button>
              <Button
                disabled={isOpening}
                onClick={() => void copyLoginLink()}
                type="button"
                variant="outline"
              >
                <Copy />
                {copied ? t("copied") : t("copyLink")}
              </Button>
            </div>
          )}
        </div>

        {isWaiting && !message && (
          <p className="text-sm leading-6 text-muted-foreground">
            {t("waitingHint")}
          </p>
        )}

        {message && (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

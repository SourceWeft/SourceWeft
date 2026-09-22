"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
  clearPendingDesktopAuth,
  setPendingDesktopAuth,
} from "../../../lib/desktop-auth";
import { authClient } from "../../../lib/auth-client";
import { desktopBridge } from "../../../lib/desktop-bridge";
import { apiBaseUrl } from "../../../lib/sdk";

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

export function DesktopLoginView({ path }: { path: string }) {
  const router = useRouter();
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

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      const pendingAuth = getPendingDesktopAuth();
      if (!pendingAuth.state) {
        if (!cancelled) {
          setStatus("idle");
          setLoginUrl(null);
          setMessage(t("expiredMessage"));
        }
        return;
      }

      try {
        const url = new URL("/v1/desktop-auth/poll", apiBaseUrl);
        url.searchParams.set("state", pendingAuth.state);
        const response = await fetch(url, {
          credentials: "include",
        });

        if (response.status === 410) {
          clearPendingDesktopAuth(pendingAuth.state);
          if (!cancelled) {
            setStatus("idle");
            setLoginUrl(null);
            setMessage(t("expiredMessage"));
          }
          return;
        }

        if (!response.ok) {
          throw new Error(t("statusCheckFailed"));
        }

        const body = (await response.json()) as
          { status: "pending" } | { status: "complete"; token: string };

        if (body.status === "complete") {
          const result = await authClient.oneTimeToken.verify({
            token: body.token,
          });

          if (result.error) {
            throw new Error(result.error.message || t("signInFailed"));
          }

          clearPendingDesktopAuth(pendingAuth.state);
          if (!cancelled) {
            router.replace("/dashboard/chat");
            router.refresh();
          }
          return;
        }
      } catch {
        // Keep polling; transient network or backend startup races should not fail the desktop flow.
      }

      if (!cancelled) {
        timeoutId = setTimeout(() => void poll(), 1500);
      }
    }

    timeoutId = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [router, status, t]);

  async function openLogin(existingLoginUrl?: string | null) {
    const state = existingLoginUrl ? getPendingDesktopAuth().state : null;
    const nextState = state || createDesktopAuthState();
    const nextLoginUrl =
      existingLoginUrl ||
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
      setPendingDesktopAuth({ loginUrl: nextLoginUrl, state: nextState });
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
                onClick={() => void openLogin(loginUrl)}
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

        {message && (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

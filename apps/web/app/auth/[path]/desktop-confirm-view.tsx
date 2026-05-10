"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, UserRound } from "lucide-react";
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

type SessionUser = {
  email?: string | null;
  name?: string | null;
};

function getRedirectTo() {
  const params = new URLSearchParams(window.location.search);
  const redirectTo = params.get("redirectTo");
  if (!redirectTo?.startsWith("/auth/desktop-complete?")) {
    return null;
  }

  return redirectTo;
}

function getInitials(user: SessionUser | null) {
  const value = user?.name || user?.email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function DesktopConfirmView({
  onFallback,
}: {
  onFallback: () => void;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [isContinuing, setIsContinuing] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const redirectTo = useMemo(
    () => (typeof window === "undefined" ? null : getRedirectTo()),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      if (!redirectTo) {
        onFallback();
        return;
      }

      const result = await authClient.getSession();
      if (cancelled) {
        return;
      }

      if (!result.data?.session) {
        onFallback();
        return;
      }

      setUser(result.data.user ?? null);
      setIsLoading(false);
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [onFallback, redirectTo]);

  function continueToDesktop() {
    if (!redirectTo) {
      onFallback();
      return;
    }

    setIsContinuing(true);
    window.location.assign(redirectTo);
  }

  if (isLoading) {
    return <div className="min-h-40 w-full max-w-md" />;
  }

  const initials = getInitials(user);

  return (
    <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
      <CardHeader className="gap-4">
        <div className="flex items-center gap-3">
          <Logo className="h-10 w-10 rounded-lg" />
          <div>
            <CardTitle className="text-lg">Continue to SourceWeft</CardTitle>
            <CardDescription className="mt-1">
              Confirm this account for the desktop app.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background text-sm font-semibold text-foreground ring-1 ring-border">
            {initials || <UserRound className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {user?.name || "SourceWeft User"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {user?.email || "Signed in"}
            </div>
          </div>
        </div>

        <Button
          className="w-full"
          disabled={isContinuing}
          onClick={continueToDesktop}
          size="lg"
          type="button"
        >
          <Check />
          Continue in desktop
        </Button>
      </CardContent>
    </Card>
  );
}

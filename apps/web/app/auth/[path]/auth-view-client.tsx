"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopBridge } from "../../../lib/desktop-bridge";
import { DesktopConfirmView } from "./desktop-confirm-view";
import { DesktopLoginView } from "./desktop-login-view";

export function AuthViewClient({ path }: { path: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  const [showDesktopConfirm, setShowDesktopConfirm] = useState(false);

  useEffect(() => {
    setIsDesktop(desktopBridge.isAvailable());
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      setShowDesktopConfirm(
        params.get("desktop") === "1" &&
          Boolean(params.get("redirectTo")?.startsWith("/auth/desktop-complete?")),
      );
    }

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setRefreshKey((value) => value + 1);
      }
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  const renderKey = useMemo(() => `${path}:${refreshKey}`, [path, refreshKey]);
  const fallbackToAuthView = useCallback(() => {
    setShowDesktopConfirm(false);
  }, []);

  if (isDesktop === null) {
    return <div className="min-h-40 w-full max-w-md" />;
  }

  if (isDesktop && path !== "callback" && path !== "sign-out") {
    return <DesktopLoginView path={path} />;
  }

  if (showDesktopConfirm && path === "sign-in") {
    return <DesktopConfirmView onFallback={fallbackToAuthView} />;
  }

  return <AuthView key={renderKey} path={path} socialLayout="grid" />;
}

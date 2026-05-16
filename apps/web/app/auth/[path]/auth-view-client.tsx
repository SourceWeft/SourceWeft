"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  detectNativeHostKind,
  type NativeHostKind,
} from "../../../lib/native-bridge";
import { DesktopConfirmView } from "./desktop-confirm-view";
import { DesktopLoginView } from "./desktop-login-view";
import { MobileLoginView } from "./mobile-login-view";

function mobileLoginViewSupportsPath(path: string) {
  return path === "sign-in" || path === "sign-up";
}

export function AuthViewClient({ path }: { path: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [nativeHostKind, setNativeHostKind] = useState<NativeHostKind | null>();
  const [showDesktopConfirm, setShowDesktopConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;

    detectNativeHostKind()
      .then((kind) => {
        if (!cancelled) {
          setNativeHostKind(kind);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNativeHostKind(null);
        }
      });

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
      cancelled = true;
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  const renderKey = useMemo(() => `${path}:${refreshKey}`, [path, refreshKey]);
  const fallbackToAuthView = useCallback(() => {
    setShowDesktopConfirm(false);
  }, []);

  if (nativeHostKind === undefined) {
    return <div className="min-h-40 w-full max-w-md" />;
  }

  if (
    nativeHostKind === "desktop" &&
    path !== "callback" &&
    path !== "sign-out"
  ) {
    return <DesktopLoginView path={path} />;
  }

  if (nativeHostKind === "mobile" && mobileLoginViewSupportsPath(path)) {
    return <MobileLoginView path={path} />;
  }

  if (showDesktopConfirm && path === "sign-in") {
    return <DesktopConfirmView onFallback={fallbackToAuthView} />;
  }

  return <AuthView key={renderKey} path={path} socialLayout="grid" />;
}

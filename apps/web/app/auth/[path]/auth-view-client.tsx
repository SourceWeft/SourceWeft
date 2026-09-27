"use client";

import { Auth } from "../../_components/auth/auth";
import { useEffect, useMemo, useState } from "react";
import {
  detectNativeHostKind,
  type NativeHostKind,
} from "../../../lib/native-bridge";
import { DesktopLoginView } from "./desktop-login-view";
import { MobileLoginView } from "./mobile-login-view";

function mobileLoginViewSupportsPath(path: string) {
  return path === "sign-in" || path === "sign-up";
}

export function AuthViewClient({ path }: { path: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [nativeHostKind, setNativeHostKind] = useState<NativeHostKind | null>();

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

  return <Auth key={renderKey} path={path} socialLayout="grid" />;
}

"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useEffect, useMemo, useState } from "react";

export function AuthViewClient({ path }: { path: string }) {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
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

  return <AuthView key={renderKey} path={path} socialLayout="grid" />;
}

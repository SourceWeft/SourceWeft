"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { detectNativeHostKind } from "../lib/native-bridge";

export function MobileHomeGate({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    detectNativeHostKind()
      .then((kind) => {
        if (cancelled) {
          return;
        }

        if (kind === "mobile") {
          router.replace("/auth/sign-in");
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [router]);

  return children;
}

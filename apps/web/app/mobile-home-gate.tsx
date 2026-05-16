"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@sourceweft/ui-web/logo";
import {
  detectNativeHostKind,
  type NativeHostKind,
} from "../lib/native-bridge";

export function MobileHomeGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [nativeHostKind, setNativeHostKind] = useState<NativeHostKind | null>();

  useEffect(() => {
    let cancelled = false;

    detectNativeHostKind()
      .then((kind) => {
        if (cancelled) {
          return;
        }

        setNativeHostKind(kind);
        if (kind === "mobile") {
          router.replace("/auth/sign-in");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNativeHostKind(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (nativeHostKind === null) {
    return children;
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background px-6 text-center text-foreground">
      <div className="flex items-center gap-2.5">
        <Logo className="h-8 w-8 rounded-lg" />
        <span className="text-2xl font-semibold tracking-normal">
          SourceWeft
        </span>
      </div>
    </main>
  );
}

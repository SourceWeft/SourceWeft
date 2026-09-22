"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Card,
  CardHeader,
  CardContent,
} from "@sourceweft/ui-web/components/ui/card";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";
import {
  detectNativeHostKind,
  type NativeHostKind,
} from "../../lib/native-bridge";

export function AuthLoadingCard({ kind }: { kind: NativeHostKind | null }) {
  if (kind === "mobile") {
    return (
      <div className="flex h-[calc(100svh-2rem)] w-full max-w-md flex-col overflow-y-auto px-1">
        <div className="my-auto w-full space-y-6 py-6">
          <div className="flex flex-col items-center gap-4">
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-9 w-64 max-w-full" />
          </div>
          <div className="space-y-2.5">
            <Skeleton className="h-12 rounded-full" />
            <Skeleton className="h-12 rounded-full" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-full" />
          </div>
          <Skeleton className="mx-auto h-3 w-52 max-w-full" />
        </div>
      </div>
    );
  }
  if (kind === "desktop") {
    return (
      <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
        <CardHeader className="gap-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-9 w-full" />
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-3 w-full" />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-9" />
          ))}
        </div>
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9" />
          </div>
        ))}
        <Skeleton className="h-9" />
        <Skeleton className="mx-auto h-3 w-40" />
      </CardContent>
    </Card>
  );
}

export function AuthRouteSkeleton() {
  const pathname = usePathname();
  const [kind, setKind] = useState<NativeHostKind | null>(null);
  useEffect(() => {
    let active = true;
    void detectNativeHostKind().then((value) => {
      if (active) setKind(value);
    });
    return () => {
      active = false;
    };
  }, []);
  const mobileForm =
    pathname === "/auth/sign-in" ||
    pathname === "/auth/sign-up" ||
    pathname === "/join";
  const browserForm =
    pathname === "/auth/callback" || pathname === "/auth/sign-out";
  const resolvedKind =
    browserForm || (kind === "mobile" && !mobileForm) ? null : kind;
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-background p-4 md:p-6">
      <AuthLoadingCard kind={resolvedKind} />
    </main>
  );
}

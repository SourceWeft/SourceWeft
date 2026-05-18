"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardChatStateProvider } from "./_components/dashboard-chat-state";
import { DashboardMobileBottomNav } from "./_components/dashboard-mobile-bottom-nav";
import { DashboardMobileContent } from "./_components/dashboard-mobile-content";
import { DashboardMobileNavProvider } from "./_components/dashboard-mobile-nav-state";
import { DashboardSidebar } from "./_components/dashboard-sidebar";
import { authClient } from "../../lib/auth-client";
import { DashboardShellRouteSkeleton } from "../_components/route-loading-skeleton";

const SESSION_CONFIRM_ATTEMPTS = 3;
const SESSION_CONFIRM_DELAY_MS = 250;

type SessionData = {
  session?: unknown;
  user?: unknown;
} | null;

type SessionResult = {
  data?: SessionData;
  session?: unknown;
  user?: unknown;
} | null;

function hasActiveSession(data: SessionData | undefined) {
  return Boolean(data?.session || data?.user);
}

function hasActiveSessionResult(result: unknown) {
  const sessionResult = result as SessionResult | undefined;
  return Boolean(
    sessionResult?.data?.session ||
      sessionResult?.data?.user ||
      sessionResult?.session ||
      sessionResult?.user,
  );
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function DashboardLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const mountedRef = useRef(false);
  const redirectToRef = useRef("/dashboard");
  const sessionConfirmingRef = useRef(false);
  const [sessionConfirming, setSessionConfirming] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const { data, isPending, refetch } = authClient.useSession();
  const hasSession = hasActiveSession(data as SessionData | undefined);
  const routePathname = pathname || "/dashboard";
  const redirectTo = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${routePathname}?${query}` : routePathname;
  }, [routePathname, searchParams]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    redirectToRef.current = redirectTo;
  }, [redirectTo]);

  useEffect(() => {
    if (
      isPending ||
      hasSession ||
      sessionConfirmingRef.current ||
      redirecting
    ) {
      return;
    }

    async function confirmSessionOrRedirect() {
      sessionConfirmingRef.current = true;
      setSessionConfirming(true);

      try {
        for (let attempt = 0; attempt < SESSION_CONFIRM_ATTEMPTS; attempt += 1) {
          const session = await authClient.getSession({
            query: {
              disableCookieCache: true,
            },
          });

          if (!mountedRef.current) {
            return;
          }

          if (hasActiveSessionResult(session)) {
            await refetch({
              query: {
                disableCookieCache: true,
              },
            });
            return;
          }

          if (attempt < SESSION_CONFIRM_ATTEMPTS - 1) {
            await delay(SESSION_CONFIRM_DELAY_MS);
          }
        }

        if (mountedRef.current) {
          setRedirecting(true);
          router.replace(
            `/auth/sign-in?redirectTo=${encodeURIComponent(
              redirectToRef.current,
            )}`,
          );
        }
      } finally {
        sessionConfirmingRef.current = false;
        if (mountedRef.current) {
          setSessionConfirming(false);
        }
      }
    }

    void confirmSessionOrRedirect();
  }, [
    hasSession,
    isPending,
    redirecting,
    refetch,
    router,
  ]);

  if (isPending || sessionConfirming || redirecting || !hasSession) {
    return <DashboardShellRouteSkeleton pathname={routePathname} />;
  }

  return (
    <SidebarProvider>
      <DashboardChatStateProvider>
        <DashboardMobileNavProvider>
          <div className="flex h-svh min-h-0 w-full overflow-hidden bg-background text-foreground">
            <DashboardSidebar />
            <main className="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
              <DashboardMobileContent>{children}</DashboardMobileContent>
            </main>
            <DashboardMobileBottomNav />
          </div>
        </DashboardMobileNavProvider>
      </DashboardChatStateProvider>
    </SidebarProvider>
  );
}

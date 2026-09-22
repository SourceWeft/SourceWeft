"use client";

import { synchronizeLocalHostScope } from "../../lib/local-host-session";
import { registerBuiltinAgentTools } from "../../lib/register-builtin-agent-tools";
import type * as React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopHubBridge } from "../../lib/desktop-hub-bridge";
import { desktopBridge } from "../../lib/desktop-bridge";
import { toast } from "sonner";
import { hubSkillMemory } from "../../lib/hub-skill-memory";
import { ChatHubProvider } from "./chat/_components/chat-hub-context";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardChatStateProvider } from "./_components/dashboard-chat-state";
import { DashboardMobileBottomNav } from "./_components/dashboard-mobile-bottom-nav";
import { DashboardMobileContent } from "./_components/dashboard-mobile-content";
import { DashboardMobileNavProvider } from "./_components/dashboard-mobile-nav-state";
import { DashboardPageNavigation } from "./_components/dashboard-page-navigation";
import { DashboardSidebar } from "./_components/dashboard-sidebar";
import { DashboardWorkspaceLayout } from "./_components/dashboard-workspace-layout";
import { authClient } from "../../lib/auth-client";
import { isEmbedMode } from "../../lib/thread-embed-params";

// Only chat surfaces read the registry, so marketing pages no longer pay for
// the connector tool definitions at boot.
registerBuiltinAgentTools();
import { DashboardShellRouteSkeleton } from "../_components/dashboard-loading-skeleton";

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
  const isAuxiliaryWindow =
    pathname === "/dashboard/hub-window" ||
    pathname === "/dashboard/preview-window";
  const router = useRouter();
  const searchParams = useSearchParams();
  // An embedded thread (framed inside a sub-agent panel) shows only the
  // conversation: the sidebar and mobile nav belong to the framing page.
  const embedMode = isEmbedMode(searchParams);
  const mountedRef = useRef(false);
  const redirectToRef = useRef("/dashboard");
  const sessionConfirmingRef = useRef(false);
  const [sessionConfirming, setSessionConfirming] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [hasConfirmedSession, setHasConfirmedSession] = useState(false);
  const { data, isPending, refetch } = authClient.useSession();
  const previousAccountId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const accountId = data?.user?.id;
    if (
      previousAccountId.current &&
      previousAccountId.current !== accountId &&
      !isPending
    ) {
      hubSkillMemory.clear();
      if (!isAuxiliaryWindow && desktopBridge.isAvailable())
        void desktopHubBridge
          .action("logout")
          .catch((error) => toast.error(error.message));
    }
    if (!isPending) previousAccountId.current = accountId;
  }, [data?.user?.id, isPending, isAuxiliaryWindow]);
  const hasSession = hasActiveSession(data as SessionData | undefined);
  const userId = data?.user?.id;
  const sessionId = data?.session?.id;
  useLayoutEffect(() => {
    if (isPending || isAuxiliaryWindow) return;
    void synchronizeLocalHostScope(
      hasSession ? userId : undefined,
      hasSession ? sessionId : undefined,
    ).catch((error) =>
      console.error("Local host initialization unavailable", error),
    );
  }, [hasSession, isPending, userId, sessionId, isAuxiliaryWindow]);
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
    if (hasSession) {
      setHasConfirmedSession(true);
    }
  }, [hasSession]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscroll = body.style.overscrollBehavior;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, []);

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
        for (
          let attempt = 0;
          attempt < SESSION_CONFIRM_ATTEMPTS;
          attempt += 1
        ) {
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
  }, [hasSession, isPending, redirecting, refetch, router]);

  if (
    sessionConfirming ||
    redirecting ||
    (!hasSession && (!isPending || !hasConfirmedSession))
  ) {
    return <DashboardShellRouteSkeleton pathname={pathname} embedMode={embedMode} />;
  }

  if (isAuxiliaryWindow) {
    return (
      <main className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        {children}
      </main>
    );
  }

  return (
    <SidebarProvider className="!h-dvh !min-h-0 overflow-hidden overscroll-none">
      <DashboardChatStateProvider>
        <DashboardMobileNavProvider>
          <DashboardWorkspaceLayout>
            <ChatHubProvider key={data?.user?.id}>
              {embedMode ? null : <DashboardSidebar />}
              <main
                className={
                  embedMode
                    ? "min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden"
                    : "min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
                }
              >
                {embedMode ? (
                  children
                ) : (
                  <>
                    <DashboardPageNavigation />
                    <DashboardMobileContent>{children}</DashboardMobileContent>
                  </>
                )}
              </main>
              {embedMode ? null : <DashboardMobileBottomNav />}
            </ChatHubProvider>
          </DashboardWorkspaceLayout>
        </DashboardMobileNavProvider>
      </DashboardChatStateProvider>
    </SidebarProvider>
  );
}

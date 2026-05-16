"use client";

import type * as React from "react";
import {
  AuthLoading,
  RedirectToSignIn,
  SignedIn,
} from "@daveyplate/better-auth-ui";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardChatStateProvider } from "./_components/dashboard-chat-state";
import { DashboardMobileBottomNav } from "./_components/dashboard-mobile-bottom-nav";
import { DashboardMobileContent } from "./_components/dashboard-mobile-content";
import { DashboardMobileNavProvider } from "./_components/dashboard-mobile-nav-state";
import { DashboardSidebar } from "./_components/dashboard-sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <RedirectToSignIn />
      <AuthLoading>
        <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-8 text-sm text-zinc-500">
          Loading session...
        </main>
      </AuthLoading>
      <SignedIn>
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
      </SignedIn>
    </>
  );
}

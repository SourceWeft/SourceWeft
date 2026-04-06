"use client";

import type * as React from "react";
import {
  AuthLoading,
  RedirectToSignIn,
  SignedIn,
} from "@daveyplate/better-auth-ui";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardChatStateProvider } from "./_components/dashboard-chat-state";
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
            <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
              <DashboardSidebar />
              <main className="min-w-0 flex flex-1 flex-col overflow-hidden">
                {children}
              </main>
            </div>
          </DashboardChatStateProvider>
        </SidebarProvider>
      </SignedIn>
    </>
  );
}

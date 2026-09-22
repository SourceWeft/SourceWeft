"use client";

import { usePathname } from "next/navigation";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import {
  DashboardWorkspaceLayout,
  useWorkspaceLayout,
} from "../dashboard/_components/dashboard-workspace-layout";
import { DashboardSidebarBrand } from "../dashboard/_components/dashboard-sidebar-brand";
import { DashboardPageNavigation } from "../dashboard/_components/dashboard-page-navigation";
import {
  ChatThreadPagePanelSkeleton,
  DashboardContentRouteSkeleton,
  DashboardMobileBottomNavSkeleton,
  DashboardSidebarSkeleton,
  DashboardSkeletonContentForPath,
} from "./route-loading-skeleton";

// Route loading renders inside the existing dashboard shell.
export function DashboardLoadingSkeleton() {
  const pathname = usePathname();
  return (
    <DashboardContentRouteSkeleton>
      <div className="flex h-full min-h-0 flex-col">
        <DashboardSkeletonContentForPath pathname={pathname} />
      </div>
    </DashboardContentRouteSkeleton>
  );
}

function DashboardLoadingShellContent({
  pathname,
}: {
  pathname?: string | null;
}) {
  const { conversationsDocked, conversationWidth, railWidth, desktopTitlebar } =
    useWorkspaceLayout();

  return (
    <>
      {railWidth > 0 && (
        <DashboardSidebarSkeleton
          width={railWidth}
          collapsed
          brand={<DashboardSidebarBrand collapsed />}
        />
      )}
      {conversationsDocked && (
        <DashboardSidebarSkeleton
          width={conversationWidth}
          desktopTitlebar={desktopTitlebar}
          brand={<DashboardSidebarBrand />}
        />
      )}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <DashboardPageNavigation />
        <DashboardSkeletonContentForPath pathname={pathname} />
      </section>
      <DashboardMobileBottomNavSkeleton />
    </>
  );
}

// Session loading owns the shell and shares its sizing and saved preferences.
export function DashboardShellRouteSkeleton({
  pathname,
  embedMode = false,
}: {
  pathname?: string | null;
  embedMode?: boolean;
}) {
  if (
    embedMode ||
    pathname === "/dashboard/hub-window" ||
    pathname === "/dashboard/preview-window"
  ) {
    return (
      <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        {embedMode ? (
          <ChatThreadPagePanelSkeleton />
        ) : (
          <DashboardSkeletonContentForPath pathname={pathname} />
        )}
      </main>
    );
  }
  return (
    <SidebarProvider className="!h-dvh !min-h-0 overflow-hidden overscroll-none">
      <DashboardWorkspaceLayout>
        <DashboardLoadingShellContent pathname={pathname} />
      </DashboardWorkspaceLayout>
    </SidebarProvider>
  );
}

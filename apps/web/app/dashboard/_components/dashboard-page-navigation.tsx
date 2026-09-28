"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

/**
 * Phones reach the drawer from this strip on non-chat pages; on PC the rail
 * owns navigation, and the macOS client keeps the strip only as its titlebar.
 */
export function DashboardPageNavigation() {
  const t = useTranslations("dashboardNav");
  const pathname = usePathname();
  const {
    desktopTitlebar,
    railWidth,
    titlebarInset,
    conversationsOpen,
    toggleConversations,
  } = useWorkspaceLayout();
  const hasRail = railWidth > 0;
  if (pathname.startsWith("/dashboard/chat") || (hasRail && !desktopTitlebar))
    return null;
  const conversationLabel = conversationsOpen
    ? t("sidebar.hideSidebar")
    : t("sidebar.showSidebar");
  return (
    <div
      data-desktop-drag-region
      className={cn(
        "flex shrink-0 items-center gap-2 pr-3 sm:pr-4",
        desktopTitlebar
          ? "h-14 select-none"
          : "h-12 border-b border-border/70 sm:h-14",
        titlebarInset ? "pl-6" : "pl-3 sm:pl-4",
      )}
    >
      {hasRail ? null : (
        <Button
          data-conversations-toggle
          className="size-8"
          size="icon-sm"
          variant="ghost"
          aria-label={conversationLabel}
          title={conversationLabel}
          aria-expanded={conversationsOpen}
          onClick={toggleConversations}
        >
          {conversationsOpen ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </Button>
      )}
      <span className="text-sm font-semibold">SourceWeft</span>
    </div>
  );
}

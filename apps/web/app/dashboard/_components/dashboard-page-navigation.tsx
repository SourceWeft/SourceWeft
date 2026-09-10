"use client";

import { usePathname } from "next/navigation";
import { PanelLeftOpen } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

/** Non-chat pages must remain navigable when the unified sidebar is hidden. */
export function DashboardPageNavigation() {
  const pathname = usePathname();
  const {
    desktopTitlebar,
    conversationsDocked,
    canDockConversations,
    conversationsOpen,
    toggleConversations,
  } = useWorkspaceLayout();
  if (
    pathname.startsWith("/dashboard/chat") ||
    (!desktopTitlebar && canDockConversations)
  )
    return null;
  return (
    <div
      data-desktop-drag-region
      className={cn(
        "flex shrink-0 items-center gap-2 pr-3 sm:pr-4",
        desktopTitlebar
          ? "h-14 select-none"
          : "h-12 border-b border-border/70 sm:h-14",
        desktopTitlebar && !conversationsDocked ? "pl-[264px]" : "pl-3 sm:pl-4",
      )}
    >
      {!desktopTitlebar && (
        <Button
          data-conversations-toggle
          className="size-8"
          size="icon-sm"
          variant="ghost"
          aria-label="Show sidebar"
          aria-expanded={conversationsOpen}
          onClick={toggleConversations}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <span className="text-sm font-semibold">SourceWeft</span>
    </div>
  );
}

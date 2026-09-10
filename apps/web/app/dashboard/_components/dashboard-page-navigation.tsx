"use client";

import { usePathname } from "next/navigation";
import { PanelLeftOpen } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

/** Non-chat pages must remain navigable when the unified sidebar is hidden. */
export function DashboardPageNavigation() {
  const pathname = usePathname();
  const { canDockConversations, conversationsOpen, toggleConversations } =
    useWorkspaceLayout();
  if (pathname.startsWith("/dashboard/chat") || canDockConversations)
    return null;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:h-14 sm:px-4">
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
      <span className="text-sm font-semibold">SourceWeft</span>
    </div>
  );
}

"use client";

import {
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

/** The native titlebar's left-side controls, positioned over the sidebar only. */
export function DesktopTitlebarControls() {
  const { desktopTitlebar, conversationsOpen, toggleConversations } =
    useWorkspaceLayout();

  if (!desktopTitlebar) return null;

  return (
    <div
      data-desktop-drag-region
      className="fixed left-0 top-0 z-50 flex h-14 w-[248px] select-none items-center justify-end border-b border-sidebar-border/70 bg-sidebar/95 pr-3 pl-[96px] backdrop-blur"
    >
      <Button
        data-conversations-toggle
        variant="ghost"
        size="icon-sm"
        className="size-8 shrink-0 text-sidebar-foreground/80"
        aria-label={conversationsOpen ? "Collapse sidebar" : "Expand sidebar"}
        title={conversationsOpen ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={conversationsOpen}
        onClick={toggleConversations}
      >
        {conversationsOpen ? (
          <PanelLeftClose className="size-4" />
        ) : (
          <PanelLeftOpen className="size-4" />
        )}
      </Button>
    </div>
  );
}

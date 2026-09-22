"use client";

import { useOptionalWorkspaceLayout } from "../dashboard/_components/dashboard-workspace-layout";
import { useDesktopTitlebar } from "../../lib/desktop-titlebar";
import { cn } from "@sourceweft/ui-web/lib/utils";

export function ChatHeaderSkeleton() {
  const layout = useOptionalWorkspaceLayout();
  const desktopTitlebar = useDesktopTitlebar();
  return (
    <header
      data-desktop-drag-region
      className={cn(
        "sticky top-0 z-10 min-w-0 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur",
        desktopTitlebar ? "h-14 select-none" : "h-12 sm:h-14",
      )}
    >
      <div
        className={cn(
          "flex h-full min-w-0 items-center gap-2 pr-3 sm:pr-4",
          desktopTitlebar && !layout?.conversationsDocked
            ? "pl-[264px]"
            : "pl-3 sm:pl-4",
        )}
      >
        <div className="size-8 shrink-0 rounded-md bg-muted/60" />
        <div className="min-w-0 flex-1">
          <div className="h-4 w-32 max-w-full rounded-full bg-muted/60" />
        </div>
        <div className="size-8 shrink-0 rounded-md bg-muted/60" />
        <div className="size-8 shrink-0 rounded-md bg-muted/60" />
      </div>
    </header>
  );
}

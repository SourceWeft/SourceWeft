"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { desktopBridge } from "../../../lib/desktop-bridge";
import { SourceWeftBrandMark } from "../../_landing/components/sourceweft-brand";

// The native host is injected before the app mounts; viewport width does not
// distinguish a desktop browser from the installed PC client.
const subscribe = () => () => {};
const serverSnapshot = () => false;

export function DashboardSidebarBrand({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const isDesktop = useSyncExternalStore(
    subscribe,
    desktopBridge.isAvailable,
    serverSnapshot,
  );
  if (isDesktop) return null;

  return (
    <Link
      href="/dashboard"
      aria-label="SourceWeft"
      title={collapsed ? "SourceWeft" : undefined}
      className={
        collapsed
          ? "mb-3 flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-sidebar-accent"
          : "flex h-12 min-w-0 shrink-0 items-center gap-2.5 rounded-lg px-2 text-sidebar-foreground hover:bg-sidebar-accent sm:h-14"
      }
    >
      <SourceWeftBrandMark className="size-7 rounded-md" />
      {!collapsed && (
        <span className="truncate font-brand text-base font-semibold tracking-tight">
          SourceWeft
        </span>
      )}
    </Link>
  );
}

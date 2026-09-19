"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { desktopBridge } from "../../lib/desktop-bridge";
import {
  isTitlebarDragTarget,
  useDesktopTitlebar,
} from "../../lib/desktop-titlebar";

/** Only blank titlebar space drags; nested controls retain ordinary pointer events. */
export function DesktopWindowChrome() {
  const enabled = useDesktopTitlebar();
  const pathname = usePathname();

  useEffect(() => {
    if (!enabled) return;
    const onMouseDown = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        !isTitlebarDragTarget(event.target)
      )
        return;
      event.preventDefault();
      void desktopBridge
        .titlebarAction(event.detail === 2 ? "toggleMaximize" : "drag")
        .catch((error: Error) => toast.error(error.message));
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [enabled]);

  // Authentication has no dashboard header to supply a drag region.
  if (!enabled || !pathname.startsWith("/auth")) return null;
  return (
    <div
      data-desktop-drag-region
      className="fixed inset-x-0 top-0 z-30 h-14 select-none bg-background"
      aria-hidden="true"
    />
  );
}

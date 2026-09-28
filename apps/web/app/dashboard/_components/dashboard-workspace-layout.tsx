"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useSidebar } from "@sourceweft/ui-web/components/ui/sidebar";
import { useElementSize } from "../../../lib/use-element-size";
import { resolveWorkspaceLayout } from "./workspace-layout";
import { useDesktopTitlebar } from "../../../lib/desktop-titlebar";

const PREFERENCE_KEY = "sourceweft:conversations-expanded";
type Layout = ReturnType<typeof resolveWorkspaceLayout> & {
  ready: boolean;
  desktopTitlebar: boolean;
  hubDrawerOpen: boolean;
  setHubDrawerOpen: (open: boolean) => void;
  /** The conversation column slid out over a page it cannot dock beside. */
  conversationOverlayOpen: boolean;
  conversationsOpen: boolean;
  toggleConversations: () => void;
  /** Closes the drawer or overlay after a pick; a docked column stays. */
  closeConversations: () => void;
};
const Context = createContext<Layout | null>(null);

export function DashboardWorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const pathname = usePathname() ?? "";
  const { openMobile, setOpenMobile } = useSidebar();
  const [conversationPreference, setConversationPreference] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [hubDrawerOpen, setHubOpen] = useState(false);
  const desktopTitlebar = useDesktopTitlebar();
  const layout = resolveWorkspaceLayout(
    width,
    conversationPreference,
    desktopTitlebar,
    pathname.startsWith("/dashboard/chat"),
  );
  const hasRail = layout.railWidth > 0;

  useEffect(() => {
    try {
      setConversationPreference(
        localStorage.getItem(PREFERENCE_KEY) !== "false",
      );
    } catch {
      /* Storage can be unavailable in a private WebView. */
    }
  }, []);
  // A resize only changes presentation; it never overwrites a saved preference.
  useEffect(() => {
    if (hasRail) setOpenMobile(false);
    if (layout.canDockHub) setHubOpen(false);
  }, [hasRail, layout.canDockHub, setOpenMobile]);
  // The overlay belongs to the page and the size it was opened on.
  useEffect(() => {
    setOverlayOpen(false);
  }, [pathname, hasRail, layout.canDockConversations]);
  useEffect(() => {
    if (openMobile) setHubOpen(false);
  }, [openMobile]);

  const setHubDrawerOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setOpenMobile(false);
        setOverlayOpen(false);
      }
      setHubOpen(open);
    },
    [setOpenMobile],
  );
  const toggleConversations = useCallback(() => {
    if (!hasRail) {
      setHubOpen(false);
      setOpenMobile(!openMobile);
      return;
    }
    // Other pages have no conversation list; the rail navigates to chat.
    if (!layout.conversationRoute) return;
    if (!layout.canDockConversations) {
      setHubOpen(false);
      setOverlayOpen((open) => !open);
      return;
    }
    const next = !conversationPreference;
    setConversationPreference(next);
    try {
      localStorage.setItem(PREFERENCE_KEY, String(next));
    } catch {
      /* Keep the in-memory preference. */
    }
  }, [
    hasRail,
    layout.conversationRoute,
    layout.canDockConversations,
    conversationPreference,
    openMobile,
    setOpenMobile,
  ]);
  const closeConversations = useCallback(() => {
    setOpenMobile(false);
    setOverlayOpen(false);
  }, [setOpenMobile]);

  const value = useMemo(
    () => ({
      ...layout,
      desktopTitlebar,
      ready: width > 0,
      hubDrawerOpen,
      setHubDrawerOpen,
      conversationOverlayOpen: overlayOpen,
      toggleConversations,
      closeConversations,
      conversationsOpen:
        layout.conversationsDocked || openMobile || overlayOpen,
    }),
    [
      layout,
      desktopTitlebar,
      width,
      hubDrawerOpen,
      overlayOpen,
      openMobile,
      setHubDrawerOpen,
      toggleConversations,
      closeConversations,
    ],
  );
  return (
    <Context.Provider value={value}>
      <div
        ref={ref}
        data-workspace-layout={layout.mode}
        data-short-window={height > 0 && height <= 720 ? "true" : undefined}
        className="relative flex h-dvh min-h-0 w-full overflow-hidden overscroll-none bg-background text-foreground"
      >
        {children}
      </div>
    </Context.Provider>
  );
}

export function useWorkspaceLayout() {
  const value = useContext(Context);
  if (!value)
    throw new Error("Workspace layout must be inside DashboardWorkspaceLayout");
  return value;
}

export function useOptionalWorkspaceLayout() {
  return useContext(Context);
}

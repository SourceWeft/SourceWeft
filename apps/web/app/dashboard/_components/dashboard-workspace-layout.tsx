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
  conversationsOpen: boolean;
  toggleConversations: () => void;
};
const Context = createContext<Layout | null>(null);

export function DashboardWorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const { openMobile, setOpenMobile } = useSidebar();
  const [conversationPreference, setConversationPreference] = useState(true);
  const [hubDrawerOpen, setHubOpen] = useState(false);
  const desktopTitlebar = useDesktopTitlebar();
  const layout = resolveWorkspaceLayout(
    width,
    conversationPreference,
    desktopTitlebar,
  );

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
    if (layout.canDockConversations) setOpenMobile(false);
    if (layout.canDockHub) setHubOpen(false);
  }, [layout.canDockConversations, layout.canDockHub, setOpenMobile]);
  useEffect(() => {
    if (openMobile) setHubOpen(false);
  }, [openMobile]);

  const setHubDrawerOpen = useCallback(
    (open: boolean) => {
      if (open) setOpenMobile(false);
      setHubOpen(open);
    },
    [setOpenMobile],
  );
  const toggleConversations = useCallback(() => {
    if (!layout.canDockConversations) {
      setHubOpen(false);
      setOpenMobile(!openMobile);
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
    layout.canDockConversations,
    conversationPreference,
    openMobile,
    setOpenMobile,
  ]);

  const value = useMemo(
    () => ({
      ...layout,
      desktopTitlebar,
      ready: width > 0,
      hubDrawerOpen,
      setHubDrawerOpen,
      toggleConversations,
      conversationsOpen: layout.conversationsDocked || openMobile,
    }),
    [
      layout,
      desktopTitlebar,
      width,
      hubDrawerOpen,
      openMobile,
      setHubDrawerOpen,
      toggleConversations,
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

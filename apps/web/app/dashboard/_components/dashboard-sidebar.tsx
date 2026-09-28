"use client";

import { contentClient } from "../../../lib/sdk";
import { toast } from "sonner";
import * as React from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PenSquare,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { useSidebar } from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { DashboardAccountMenu } from "./dashboard-account-menu";
import { useDashboardChatState } from "./dashboard-chat-state";
import { McpIcon, SkillIcon } from "../../_components/site-icons";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";
import { WorkspaceMembersDialog } from "./workspace-members-dialog";
import { copyStoredByokState } from "../chat/_components/byok-state";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";
import { DashboardSidebarBrand } from "./dashboard-sidebar-brand";
import { MARKET_ADMIN_HREF, MarketAdminNavLink } from "./market-admin-nav-link";

type NavItem = {
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (pathname: string) => boolean;
  /** Secondary destinations live under "More" in the rail and the drawer. */
  more?: boolean;
  /** The drawer is the conversation list itself, so Chat is rail-only. */
  railOnly?: boolean;
};

const navMain: NavItem[] = [
  {
    labelKey: "nav.overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    match: (p) => p === "/dashboard",
  },
  {
    labelKey: "nav.chat",
    href: "/dashboard/chat",
    icon: MessageSquareText,
    match: (p) => p.startsWith("/dashboard/chat"),
    railOnly: true,
  },
  {
    labelKey: "nav.skills",
    href: "/dashboard/skills",
    icon: SkillIcon,
    match: (p) => p.startsWith("/dashboard/skills"),
  },
  {
    labelKey: "nav.mcp",
    href: "/dashboard/mcp",
    icon: McpIcon,
    match: (p) => p.startsWith("/dashboard/mcp"),
  },
  {
    labelKey: "nav.observability",
    href: "/dashboard/observability",
    icon: Activity,
    match: (p) => p.startsWith("/dashboard/observability"),
    more: true,
  },
];
const primaryNav = navMain.filter((item) => !item.more);
const drawerNav = primaryNav.filter((item) => !item.railOnly);
const moreNav = navMain.filter((item) => item.more);

function NavigationLink({
  active,
  href,
  icon: Icon,
  label,
  onNavigate,
}: {
  active?: boolean;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      aria-current={active ? "page" : undefined}
      href={href}
      onClick={onNavigate}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

export function DashboardSidebar() {
  const t = useTranslations("dashboardNav");
  const pathname = usePathname();
  const router = useRouter();
  const { openMobile, setOpenMobile } = useSidebar();
  const {
    closeConversations,
    conversationOverlayOpen,
    conversationsDocked,
    desktopTitlebar,
    conversationWidth,
    railWidth,
  } = useWorkspaceLayout();
  const overlayRef = React.useRef<HTMLElement>(null);
  const [search, setSearch] = React.useState("");
  // Member management is per-workspace, not an account setting — it opens as
  // its own dialog rather than a settings-center tab.
  const [membersOpen, setMembersOpen] = React.useState(false);

  // Pattern: /dashboard/chat/[threadId]. While a newly created chat is
  // navigating from /dashboard/chat to /dashboard/chat/[threadId], context has
  // the new active id one render before the URL catches up.
  const routeThreadId = pathname.startsWith("/dashboard/chat/")
    ? (pathname.slice("/dashboard/chat/".length).split("/")[0] ?? "")
    : "";

  const {
    activeChatId,
    archivedChats,
    archiveChat,
    clearArchivedChats,
    clearPrivateChats,
    createChat,
    createWorkspace,
    deleteChat,
    setChatVisibility,
    privateChats,
    hasMorePrivateChats,
    isLoadingPrivateChats,
    loadMorePrivateChats,
    mode,
    renameWorkspace,
    switchWorkspace,
    sharedChats,
    startNewChat,
    workspaceId,
    workspaceName,
    workspaces,
  } = useDashboardChatState();

  const activeThreadId =
    routeThreadId ||
    (pathname === "/dashboard/chat" && mode === "thread" ? activeChatId : "");

  const handleDeleteChat = async (id: string) => {
    await deleteChat(id);

    if (id === activeThreadId) {
      router.push("/dashboard/chat");
    }
  };

  const handleClearPrivateChats = async () => {
    const shouldResetRoute = privateChats.some(
      (item) => item.id === activeThreadId,
    );

    await clearPrivateChats();

    if (shouldResetRoute) {
      router.push("/dashboard/chat");
    }
  };

  const handleClearArchivedChats = async () => {
    const shouldResetRoute = archivedChats.some(
      (item) => item.id === activeThreadId,
    );

    await clearArchivedChats();

    if (shouldResetRoute) {
      router.push("/dashboard/chat");
    }
  };

  const handleCreateWorkspace = async (name: string) => {
    const workspace = await createWorkspace(name);
    if (!workspace) {
      throw new Error("Failed to create workspace");
    }

    router.push("/dashboard/chat");
  };

  const handleStartNewChat = async () => {
    let query = new URLSearchParams(window.location.search);
    if (workspaceId && activeThreadId) {
      try {
        const { thread } = await contentClient.getThread(
          workspaceId,
          activeThreadId,
        );
        const target = thread.executionTarget ?? { kind: "cloud" };
        query = new URLSearchParams({
          computer: target.kind === "local" ? target.deviceId : "cloud",
        });
        if (target.kind === "local" && target.folderId)
          query.set("folder", target.folderId);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sidebar.conversationLoadError"),
        );
        return;
      }
    }

    if (workspaceId && activeThreadId) {
      copyStoredByokState({
        workspaceId,
        fromBucket: activeThreadId,
        toBucket: null,
      });
    }

    query.set("draft", crypto.randomUUID());
    startNewChat();
    closeConversations();
    router.push(`/dashboard/chat${query.size ? `?${query.toString()}` : ""}`);
  };

  // A persona-owned thread lands in the list like any created chat, nested
  // under its parent when one was chosen, then opens like a click on its row.
  const handleCreateAgentChat = async (input: {
    personaId: string;
    parentThreadId: string | null;
  }) => {
    const created = await createChat(input);
    if (!created) {
      throw new Error("Failed to create agent chat");
    }

    closeConversations();
    router.prefetch(`/dashboard/chat/${created.id}`);
    router.push(`/dashboard/chat/${created.id}`);
  };

  // A thread is its own route, so a separate window is just that route.
  const handleOpenChatInNewWindow = (id: string) => {
    window.open(`/dashboard/chat/${id}`, "_blank", "noopener,noreferrer");
  };

  // A nested conversation opens beside its parent: the parent's page with the
  // child named in the URL, which the thread page turns into the side panel.
  const handleOpenChatInPanel = (parentId: string, childId: string) => {
    closeConversations();
    router.push(
      `/dashboard/chat/${parentId}?agent=${encodeURIComponent(childId)}`,
    );
  };

  const handleRenameWorkspace = async (workspaceId: string, name: string) => {
    const workspace = await renameWorkspace(workspaceId, name);
    if (!workspace) {
      throw new Error("Failed to rename workspace");
    }
  };

  const handleOpenChat = (id: string) => {
    closeConversations();
    router.prefetch(`/dashboard/chat/${id}`);
    router.push(`/dashboard/chat/${id}`);
  };

  const handlePrefetchChat = React.useCallback(
    (id: string) => {
      router.prefetch(`/dashboard/chat/${id}`);
    },
    [router],
  );

  React.useEffect(() => {
    for (const chat of privateChats.slice(0, 5)) {
      router.prefetch(`/dashboard/chat/${chat.id}`);
    }
  }, [privateChats, router]);

  const handleWorkspaceChange = (nextId: string) => {
    closeConversations();
    void switchWorkspace(nextId).then((switched) => {
      if (switched) {
        router.push("/dashboard/chat");
      }
    });
  };

  // Everything the conversation list needs, shared by the docked column, the
  // overlay and the phone drawer.
  const panelProps = {
    search,
    onSearchChange: setSearch,
    archivedChats,
    activeChatId: activeThreadId,
    onArchiveChat: archiveChat,
    onClearArchivedChats: handleClearArchivedChats,
    onClearPrivateChats: handleClearPrivateChats,
    onCreateAgentChat: handleCreateAgentChat,
    onCreateChat: handleStartNewChat,
    onCreateWorkspace: handleCreateWorkspace,
    onDeleteChat: handleDeleteChat,
    onSetChatVisibility: setChatVisibility,
    onLoadMoreChats: () => void loadMorePrivateChats(),
    onOpenMembers: () => setMembersOpen(true),
    onOpenChat: handleOpenChat,
    onOpenChatInNewWindow: handleOpenChatInNewWindow,
    onOpenChatInPanel: handleOpenChatInPanel,
    onPrefetchChat: handlePrefetchChat,
    onRenameWorkspace: handleRenameWorkspace,
    hasMorePrivateChats,
    isLoadingPrivateChats,
    privateChats,
    sharedChats,
    onWorkspaceChange: handleWorkspaceChange,
    workspaceId,
    workspaceName,
    workspaces,
  };

  const moreActive =
    moreNav.some((item) => item.match(pathname)) ||
    pathname.startsWith(MARKET_ADMIN_HREF);
  const renderMoreItems = () => (
    <>
      {moreNav.map((item) => (
        <DropdownMenuItem key={item.href} asChild>
          <Link
            href={item.href}
            onClick={closeConversations}
            aria-current={item.match(pathname) ? "page" : undefined}
          >
            <item.icon className="size-4" />
            {t(item.labelKey)}
          </Link>
        </DropdownMenuItem>
      ))}
      {/* Market admins only; renders nothing for anyone else. */}
      <MarketAdminNavLink onNavigate={closeConversations} variant="menu-item" />
    </>
  );

  // The drawer's destinations; the rail renders the same list plus Chat.
  const renderNavigation = () => (
    <nav
      aria-label={t("nav.mainNavigation")}
      className="shrink-0 border-b border-sidebar-border/60 px-3 pb-2"
    >
      <div className="space-y-0">
        {drawerNav.map((item) => (
          <NavigationLink
            key={item.href}
            active={item.match(pathname)}
            href={item.href}
            icon={item.icon}
            label={t(item.labelKey)}
            onNavigate={closeConversations}
          />
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              "h-9 w-full justify-start gap-2 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/75",
              moreActive && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <MoreHorizontal className="size-4 shrink-0" />
            {t("nav.more")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {renderMoreItems()}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );

  // On PC the rail carries New chat, navigation and the account, and the chat
  // header the toggle, so the column holds only the workspace's conversations.
  const renderColumn = (heading: React.ReactNode = null) => (
    <DashboardSidebarChatPanel
      {...panelProps}
      desktopTitlebar={desktopTitlebar}
      heading={heading}
      navigation={null}
      footer={null}
      showCreateChat={false}
    />
  );

  const railLinkClass = (active: boolean) =>
    cn(
      "flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      active && "bg-sidebar-accent text-foreground",
    );

  const renderRail = () => (
    <aside
      data-testid="navigation-rail"
      style={{ width: railWidth }}
      className={cn(
        "flex h-svh shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar px-2 pb-3",
        desktopTitlebar ? "pt-0" : "pt-3",
      )}
    >
      {desktopTitlebar ? (
        // The traffic lights sit here; the strip drags the window.
        <div
          aria-hidden="true"
          data-desktop-drag-region=""
          className="h-10 w-full shrink-0 select-none"
        />
      ) : (
        <DashboardSidebarBrand collapsed />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-9 text-muted-foreground"
        aria-label={t("sidebar.newChat")}
        title={t("sidebar.newChat")}
        onClick={handleStartNewChat}
      >
        <PenSquare className="size-4" />
      </Button>
      <div aria-hidden="true" className="my-2 h-px w-6 bg-sidebar-border" />
      <nav aria-label={t("nav.mainNavigation")} className="flex flex-col gap-1">
        {primaryNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-label={t(item.labelKey)}
            title={t(item.labelKey)}
            aria-current={item.match(pathname) ? "page" : undefined}
            onClick={closeConversations}
            className={railLinkClass(item.match(pathname))}
          >
            <item.icon className="size-4" />
          </Link>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "size-9 text-muted-foreground",
                moreActive && "bg-sidebar-accent text-foreground",
              )}
              aria-label={t("nav.more")}
              title={t("nav.more")}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-52">
            {renderMoreItems()}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
      <div className="mt-auto">
        <DashboardAccountMenu />
      </div>
    </aside>
  );

  React.useEffect(() => {
    if (conversationOverlayOpen) overlayRef.current?.focus();
  }, [conversationOverlayOpen]);

  const renderOverlay = () => (
    <>
      <div
        aria-hidden="true"
        data-testid="conversation-overlay-backdrop"
        style={{ left: railWidth }}
        className="absolute inset-y-0 right-0 z-30 bg-black/10 animate-in fade-in-0 duration-150"
        onClick={closeConversations}
      />
      <aside
        ref={overlayRef}
        tabIndex={-1}
        data-testid="conversation-overlay"
        aria-label={t("chats.heading")}
        style={{ left: railWidth, width: conversationWidth }}
        className="absolute inset-y-0 z-40 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-xl outline-none animate-in fade-in-0 slide-in-from-left-4 duration-150"
        onKeyDown={(event) => {
          // Menus and dialogs opened from the list portal outside the panel
          // and close themselves on Escape.
          if (
            event.key !== "Escape" ||
            !event.currentTarget.contains(event.target as Node)
          )
            return;
          event.stopPropagation();
          closeConversations();
          document
            .querySelector<HTMLButtonElement>("[data-conversations-toggle]")
            ?.focus();
        }}
      >
        {/* The overlay covers the chat header's toggle, so it closes here. */}
        {renderColumn(
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={t("sidebar.hideConversations")}
            title={t("sidebar.hideConversations")}
            onClick={closeConversations}
          >
            <PanelLeftClose className="size-4" />
          </Button>,
        )}
      </aside>
    </>
  );

  return (
    <>
      {railWidth > 0 && renderRail()}
      {conversationsDocked && (
        <aside
          data-testid="conversation-sidebar"
          style={{ width: conversationWidth }}
          className="flex h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        >
          {renderColumn()}
        </aside>
      )}
      {conversationOverlayOpen && renderOverlay()}

      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          onCloseAutoFocus={(event) => {
            const trigger = document.querySelector<HTMLButtonElement>(
              "[data-conversations-toggle]",
            );
            if (trigger) {
              event.preventDefault();
              trigger.focus();
            }
          }}
          className="gap-0 overflow-hidden bg-sidebar p-0 text-sidebar-foreground w-[min(320px,calc(100vw-2rem))] max-w-none [&>button]:hidden"
          side="left"
        >
          <SheetTitle className="sr-only">{t("sidebar.sheetTitle")}</SheetTitle>
          <DashboardSidebarChatPanel
            {...panelProps}
            brand={<DashboardSidebarBrand />}
            heading={
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-8 shrink-0 text-muted-foreground"
                aria-label={t("sidebar.hideSidebar")}
                onClick={closeConversations}
              >
                <PanelLeftClose className="size-4" />
              </Button>
            }
            navigation={renderNavigation()}
            footer={
              <div className="shrink-0 border-t border-sidebar-border/60 p-3">
                <DashboardAccountMenu expanded />
              </div>
            }
          />
        </SheetContent>
      </Sheet>

      <WorkspaceMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
      />
    </>
  );
}

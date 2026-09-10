"use client";

import { contentClient } from "../../../lib/sdk";
import { toast } from "sonner";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Search,
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
import { McpIcon, SkillIcon } from "./dashboard-icons";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";
import { WorkspaceMembersDialog } from "./workspace-members-dialog";
import { copyStoredByokState } from "../chat/_components/byok-state";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

type NavItem = {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (pathname: string) => boolean;
};

const navMain: NavItem[] = [
  {
    title: "Overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    match: (p) => p === "/dashboard",
  },
  {
    title: "Skills",
    href: "/dashboard/skills",
    icon: SkillIcon,
    match: (p) => p.startsWith("/dashboard/skills"),
  },
  {
    title: "Connectors",
    href: "/dashboard/mcp",
    icon: McpIcon,
    match: (p) => p.startsWith("/dashboard/mcp"),
  },
  {
    title: "Observability",
    href: "/dashboard/observability",
    icon: Activity,
    match: (p) => p.startsWith("/dashboard/observability"),
  },
];

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
        "flex h-8 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      aria-current={active ? "page" : undefined}
      href={href}
      onClick={onNavigate}
    >
      <Icon className="h-4.5 w-4.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { openMobile, setOpenMobile } = useSidebar();
  const {
    conversationsDocked,
    conversationWidth,
    canDockConversations,
    railWidth,
    toggleConversations,
  } = useWorkspaceLayout();
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
            : "Could not load the conversation details",
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
    setOpenMobile(false);
    router.push(`/dashboard/chat${query.size ? `?${query.toString()}` : ""}`);
  };

  const handleRenameWorkspace = async (workspaceId: string, name: string) => {
    const workspace = await renameWorkspace(workspaceId, name);
    if (!workspace) {
      throw new Error("Failed to rename workspace");
    }
  };

  const handleOpenChat = (id: string) => {
    setOpenMobile(false);
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

  const handleMobileWorkspaceChange = (nextId: string) => {
    setOpenMobile(false);
    void switchWorkspace(nextId).then((switched) => {
      if (switched) {
        router.push("/dashboard/chat");
      }
    });
  };

  const renderNavigation = () => (
    <nav
      aria-label="Main navigation"
      className="shrink-0 border-b border-sidebar-border/60 px-3 pb-2"
    >
      <div className="space-y-0.5">
        {navMain.slice(0, 3).map((item) => (
          <NavigationLink
            key={item.title}
            active={item.match(pathname)}
            href={item.href}
            icon={item.icon}
            label={item.title}
            onNavigate={() => setOpenMobile(false)}
          />
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              "h-8 w-full justify-start gap-2 px-3 text-sm font-medium text-sidebar-foreground/75",
              pathname.startsWith("/dashboard/observability") &&
                "bg-sidebar-accent",
            )}
          >
            <MoreHorizontal className="size-4" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {navMain.map((item, index) => (
            <DropdownMenuItem
              key={item.title}
              asChild
              className={index < 3 ? "hidden" : undefined}
            >
              <Link
                href={item.href}
                onClick={() => setOpenMobile(false)}
                aria-current={item.match(pathname) ? "page" : undefined}
              >
                <item.icon className="size-4" />
                {item.title}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );

  const renderPanel = () => (
    <DashboardSidebarChatPanel
      heading={
        canDockConversations &&
        pathname.startsWith("/dashboard/chat") ? null : (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-8 shrink-0 text-muted-foreground"
            data-sidebar-collapse
            aria-label={
              canDockConversations ? "Collapse sidebar" : "Hide sidebar"
            }
            onClick={toggleConversations}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        )
      }
      navigation={renderNavigation()}
      footer={
        <div className="shrink-0 border-t border-sidebar-border/60 p-3">
          <DashboardAccountMenu expanded />
        </div>
      }
      search={search}
      onSearchChange={setSearch}
      archivedChats={archivedChats}
      activeChatId={activeThreadId}
      onArchiveChat={archiveChat}
      onClearArchivedChats={handleClearArchivedChats}
      onClearPrivateChats={handleClearPrivateChats}
      onCreateChat={handleStartNewChat}
      onCreateWorkspace={handleCreateWorkspace}
      onDeleteChat={handleDeleteChat}
      onSetChatVisibility={setChatVisibility}
      onLoadMoreChats={() => void loadMorePrivateChats()}
      onOpenMembers={() => setMembersOpen(true)}
      onOpenChat={handleOpenChat}
      onPrefetchChat={handlePrefetchChat}
      onRenameWorkspace={handleRenameWorkspace}
      hasMorePrivateChats={hasMorePrivateChats}
      isLoadingPrivateChats={isLoadingPrivateChats}
      privateChats={privateChats}
      sharedChats={sharedChats}
      onWorkspaceChange={handleMobileWorkspaceChange}
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      workspaces={workspaces}
    />
  );

  const renderRail = () => (
    <aside
      data-testid="navigation-rail"
      style={{ width: railWidth }}
      className="flex h-svh shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar px-2 py-3"
    >
      {!pathname.startsWith("/dashboard/chat") && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="mb-3 size-9"
          aria-label="Expand sidebar"
          onClick={toggleConversations}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-9"
        aria-label="New chat"
        title="New chat"
        onClick={handleStartNewChat}
      >
        <PenSquare className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="mb-3 size-9"
        aria-label="Show conversations"
        title="Show conversations"
        onClick={toggleConversations}
      >
        <Search className="size-4" />
      </Button>
      <nav aria-label="Main navigation" className="flex flex-col gap-1">
        {navMain.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.title}
            title={item.title}
            aria-current={item.match(pathname) ? "page" : undefined}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              item.match(pathname) && "bg-sidebar-accent text-foreground",
            )}
          >
            <item.icon className="size-4" />
          </Link>
        ))}
      </nav>
      <div className="mt-auto">
        <DashboardAccountMenu />
      </div>
    </aside>
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
          {renderPanel()}
        </aside>
      )}

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
          <SheetTitle className="sr-only">
            Navigation and conversations
          </SheetTitle>
          {renderPanel()}
        </SheetContent>
      </Sheet>

      <WorkspaceMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
      />
    </>
  );
}

"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  MessageSquareText,
} from "lucide-react";
import { Logo } from "@sourceweft/ui-web/logo";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useSidebar } from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { DashboardAccountMenu } from "./dashboard-account-menu";
import { useDashboardChatState } from "./dashboard-chat-state";
import { McpIcon, SkillIcon } from "./dashboard-icons";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";
import { copyStoredByokState } from "../chat/_components/byok-state";
import { copyStoredModelSelection } from "../chat/_components/model-selection-storage";

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
    title: "Chat",
    href: "/dashboard/chat",
    icon: MessageSquareText,
    match: (p) => p.startsWith("/dashboard/chat"),
  },
  {
    title: "Skills",
    href: "/dashboard/skills",
    icon: SkillIcon,
    match: (p) => p.startsWith("/dashboard/skills"),
  },
  {
    title: "MCP",
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

function RailButton({
  active,
  href,
  icon: Icon,
  label,
  onNavigate,
}: {
  active?: boolean;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onNavigate?: () => void;
}) {
  const className = cn(
    "flex h-10 w-10 items-center justify-center rounded-xl border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    active && "bg-accent text-foreground",
  );

  const content = (
    <>
      <Icon className="h-4.5 w-4.5" />
      <span className="sr-only">{label}</span>
    </>
  );

  if (!href) {
    return (
      <button className={className} title={label} type="button">
        {content}
      </button>
    );
  }

  return (
    <a className={className} href={href} onClick={onNavigate} title={label}>
      {content}
    </a>
  );
}

function MobileNavLink({
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
    <a
      className={cn(
        "flex h-10 min-w-0 items-center gap-3 rounded-xl px-3 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      href={href}
      onClick={onNavigate}
    >
      <Icon className="h-4.5 w-4.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </a>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { openMobile, setOpenMobile } = useSidebar();
  const hasChatPanel = pathname.startsWith("/dashboard/chat");
  const [settingsRequest, setSettingsRequest] = React.useState<{
    id: number;
    tab: "account" | "team" | "usage" | "billing";
  } | null>(null);

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
    privateChats,
    hasMorePrivateChats,
    isLoadingPrivateChats,
    loadMorePrivateChats,
    mode,
    organizationName,
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

  const handleStartNewChat = () => {
    if (workspaceId && activeThreadId) {
      copyStoredModelSelection({
        workspaceId,
        fromBucket: activeThreadId,
        toBucket: "current",
      });
      copyStoredByokState({
        workspaceId,
        fromBucket: activeThreadId,
        toBucket: null,
      });
    }

    startNewChat();
    router.push("/dashboard/chat");
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

  const renderRail = () => (
    <div className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border px-2 py-4">
      <div className="flex flex-col items-center gap-2">
        <a
          className="flex h-10 w-10 items-center justify-center text-primary"
          href="/dashboard"
          onClick={() => setOpenMobile(false)}
          title="SourceWeft"
        >
          <Logo className="h-9 w-9 bg-sidebar-accent text-sidebar-accent-foreground" />
          <span className="sr-only">SourceWeft</span>
        </a>

        <div className="mt-2 flex flex-col items-center gap-1">
          {navMain.map((item) => (
            <RailButton
              active={item.match(pathname)}
              href={item.href}
              icon={item.icon}
              key={item.title}
              label={item.title}
              onNavigate={() => setOpenMobile(false)}
            />
          ))}
        </div>
      </div>

      <DashboardAccountMenu settingsRequest={settingsRequest} />
    </div>
  );

  const renderMobileMenuPanel = () => (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-4">
        <Logo className="h-9 w-9 shrink-0 bg-sidebar-accent text-sidebar-accent-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-sidebar-foreground">
            SourceWeft
          </div>
          <div className="truncate text-xs text-sidebar-foreground/60">
            Dashboard
          </div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {navMain.map((item) => (
          <MobileNavLink
            active={item.match(pathname)}
            href={item.href}
            icon={item.icon}
            key={item.title}
            label={item.title}
            onNavigate={() => setOpenMobile(false)}
          />
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-3 py-3">
        <DashboardAccountMenu settingsRequest={settingsRequest} />
      </div>
    </div>
  );

  const renderChatPanel = ({
    onOpenChat,
    onWorkspaceChange,
  }: {
    onOpenChat: (id: string) => void;
    onWorkspaceChange: (nextId: string) => void;
  }) =>
    hasChatPanel ? (
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-r border-sidebar-border bg-card">
        <DashboardSidebarChatPanel
          archivedChats={archivedChats}
          activeChatId={activeThreadId}
          onArchiveChat={archiveChat}
          onClearArchivedChats={handleClearArchivedChats}
          onClearPrivateChats={handleClearPrivateChats}
          onCreateChat={handleStartNewChat}
          onCreateWorkspace={handleCreateWorkspace}
          onDeleteChat={handleDeleteChat}
          onLoadMoreChats={() => void loadMorePrivateChats()}
          onOpenUsage={() =>
            setSettingsRequest({ id: Date.now(), tab: "usage" })
          }
          onOpenChat={onOpenChat}
          onPrefetchChat={handlePrefetchChat}
          onRenameWorkspace={handleRenameWorkspace}
          hasMorePrivateChats={hasMorePrivateChats}
          isLoadingPrivateChats={isLoadingPrivateChats}
          privateChats={privateChats}
          sharedChats={sharedChats}
          onWorkspaceChange={onWorkspaceChange}
          organizationName={organizationName}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaces={workspaces}
        />
      </div>
    ) : null;

  const desktopChatPanel = renderChatPanel({
    onOpenChat: (id) => {
      router.prefetch(`/dashboard/chat/${id}`);
      router.push(`/dashboard/chat/${id}`);
    },
    onWorkspaceChange: (nextId) => {
      void switchWorkspace(nextId).then((switched) => {
        if (switched) {
          router.push("/dashboard/chat");
        }
      });
    },
  });

  const mobileChatPanel = renderChatPanel({
    onOpenChat: handleOpenChat,
    onWorkspaceChange: handleMobileWorkspaceChange,
  });

  return (
    <>
      <aside
        className={cn(
          "hidden h-svh shrink-0 bg-sidebar text-sidebar-foreground md:flex",
          hasChatPanel ? "w-[360px] border-r border-border" : "w-14",
        )}
      >
        {renderRail()}
        {desktopChatPanel}
      </aside>

      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          className={cn(
            "gap-0 overflow-hidden bg-sidebar p-0 text-sidebar-foreground md:hidden [&>button]:hidden",
            hasChatPanel
              ? "w-[min(100vw,360px)] max-w-none"
              : "w-[min(100vw,280px)] max-w-none",
          )}
          side="left"
        >
          <SheetTitle className="sr-only">Dashboard menu</SheetTitle>
          <div
            className={cn(
              "flex h-full min-h-0 bg-sidebar text-sidebar-foreground",
              hasChatPanel ? "w-[min(100vw,360px)]" : "w-[min(100vw,280px)]",
            )}
          >
            {hasChatPanel ? mobileChatPanel : renderMobileMenuPanel()}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  FolderKanban,
  LayoutDashboard,
  MessageSquareText,
} from "lucide-react";
import { Logo } from "@sourceweft/ui-web/logo";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { DashboardAccountMenu } from "./dashboard-account-menu";
import { useDashboardChatState } from "./dashboard-chat-state";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";

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
}: {
  active?: boolean;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
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
    <a className={className} href={href} title={label}>
      {content}
    </a>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const hasChatPanel = pathname.startsWith("/dashboard/chat");

  // Derive the active thread from the URL instead of context state.
  // Pattern: /dashboard/chat/[threadId]
  const activeThreadId = pathname.startsWith("/dashboard/chat/")
    ? pathname.slice("/dashboard/chat/".length).split("/")[0] ?? ""
    : "";

  const {
    archivedChats,
    archiveChat,
    clearArchivedChats,
    clearPrivateChats,
    deleteChat,
    privateChats,
    hasMorePrivateChats,
    isLoadingPrivateChats,
    loadMorePrivateChats,
    switchWorkspace,
    sharedChats,
    workspaceId,
    workspaceName,
    workspaces,
  } = useDashboardChatState();

  const handleDeleteChat = async (id: string) => {
    await deleteChat(id);

    if (id === activeThreadId) {
      router.push("/dashboard/chat");
    }
  };

  const handleClearPrivateChats = async () => {
    const shouldResetRoute = privateChats.some((item) => item.id === activeThreadId);

    await clearPrivateChats();

    if (shouldResetRoute) {
      router.push("/dashboard/chat");
    }
  };

  const handleClearArchivedChats = async () => {
    const shouldResetRoute = archivedChats.some((item) => item.id === activeThreadId);

    await clearArchivedChats();

    if (shouldResetRoute) {
      router.push("/dashboard/chat");
    }
  };

  return (
    <aside
      className={cn(
        "hidden h-svh shrink-0 bg-sidebar text-sidebar-foreground md:flex",
        hasChatPanel ? "w-[360px] border-r border-border" : "w-14",
      )}
    >
      <div className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border px-2 py-4">
        <div className="flex flex-col items-center gap-2">
          <a
            className="flex h-10 w-10 items-center justify-center text-primary"
            href="/dashboard"
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
              />
            ))}
            <RailButton icon={FolderKanban} label="Artifacts" />
          </div>
        </div>

        <DashboardAccountMenu />
      </div>

      {hasChatPanel ? (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-r border-sidebar-border bg-card">
          <DashboardSidebarChatPanel
            archivedChats={archivedChats}
            activeChatId={activeThreadId}
            onArchiveChat={archiveChat}
            onClearArchivedChats={handleClearArchivedChats}
            onClearPrivateChats={handleClearPrivateChats}
            onCreateChat={() => router.push("/dashboard/chat")}
            onDeleteChat={handleDeleteChat}
            onLoadMoreChats={() => void loadMorePrivateChats()}
            onOpenChat={(id) => router.push(`/dashboard/chat/${id}`)}
            hasMorePrivateChats={hasMorePrivateChats}
            isLoadingPrivateChats={isLoadingPrivateChats}
            privateChats={privateChats}
            sharedChats={sharedChats}
            onWorkspaceChange={(nextId) => {
              void switchWorkspace(nextId);
              router.push("/dashboard/chat");
            }}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            workspaces={workspaces}
          />
        </div>
      ) : null}
    </aside>
  );
}

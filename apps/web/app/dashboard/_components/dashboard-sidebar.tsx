"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { Logo } from "@sourceweft/ui-web/logo";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { DashboardAccountMenu } from "./dashboard-account-menu";
import { useDashboardChatState } from "./dashboard-chat-state";
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
    icon: Sparkles,
    match: (p) => p.startsWith("/dashboard/skills"),
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
          </div>
        </div>

        <DashboardAccountMenu settingsRequest={settingsRequest} />
      </div>

      {hasChatPanel ? (
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
            onOpenChat={(id) => router.push(`/dashboard/chat/${id}`)}
            onRenameWorkspace={handleRenameWorkspace}
            hasMorePrivateChats={hasMorePrivateChats}
            isLoadingPrivateChats={isLoadingPrivateChats}
            privateChats={privateChats}
            sharedChats={sharedChats}
            onWorkspaceChange={(nextId) => {
              startNewChat();
              void switchWorkspace(nextId);
              router.push("/dashboard/chat");
            }}
            organizationName={organizationName}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            workspaces={workspaces}
          />
        </div>
      ) : null}
    </aside>
  );
}

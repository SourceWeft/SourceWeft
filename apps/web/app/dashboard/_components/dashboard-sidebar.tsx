"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  FolderKanban,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  Sparkles,
} from "lucide-react";
import { Logo } from "@sourceweft/ui-web/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
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
];

const secondaryRoutes = [
  {
    title: "Workspace overview",
    href: "/dashboard",
    description: "Workspaces, activity, and controls.",
  },
  {
    title: "Notebook chat",
    href: "/dashboard/chat",
    description: "Source-grounded conversations.",
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

function TeamSwitcher() {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const orgList = (orgs ?? []) as Array<{ id: string; name: string; slug?: string }>;
  const activeOrgName = activeOrg?.name || "Personal workspace";

  async function handleSwitch(orgId: string | null) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
    } catch {
      toast.error("Failed to switch workspace.");
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="w-fit px-1.5">
              <div className="flex aspect-square size-5 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                <Sparkles className="size-3" />
              </div>
              <span className="truncate font-medium">{activeOrgName}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-64 rounded-lg"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Teams
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void handleSwitch(null)} className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-xs border">
                <Sparkles className="size-4 shrink-0" />
              </div>
              Personal workspace
            </DropdownMenuItem>
            {orgList.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onClick={() => void handleSwitch(org.id)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-xs border">
                  <Sparkles className="size-4 shrink-0" />
                </div>
                {org.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">Add team</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function GenericRoutePanel({ pathname }: { pathname: string }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-card">
      <div className="border-b border-border px-4 pt-4 pb-3">
        <TeamSwitcher />
      </div>

      <div className="border-b border-border px-5 py-5">
        <div className="text-base font-semibold text-foreground">Dashboard</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a workspace route
        </p>
        <div className="mt-4 rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-muted-foreground shadow-xs">
          Search...
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {secondaryRoutes.map((item) => (
          <a
            className={cn(
              "flex flex-col gap-1 border-b border-border px-5 py-4 transition-colors hover:bg-accent/50",
              pathname === item.href && "bg-accent/40",
            )}
            href={item.href}
            key={item.href}
          >
            <span className="text-sm font-medium text-foreground">
              {item.title}
            </span>
            <span className="text-xs leading-5 text-muted-foreground">
              {item.description}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const isOverviewRoute = pathname === "/dashboard";

  // Derive the active thread from the URL instead of context state.
  // Pattern: /dashboard/chat/[threadId]
  const activeThreadId = pathname.startsWith("/dashboard/chat/")
    ? pathname.slice("/dashboard/chat/".length).split("/")[0] ?? ""
    : "";

  const {
    archivedChats,
    archiveChat,
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

  return (
    <aside
      className={cn(
        "hidden h-svh shrink-0 bg-sidebar text-sidebar-foreground md:flex",
        isOverviewRoute ? "w-14" : "w-[360px] border-r border-border",
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

      {!isOverviewRoute ? (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-r border-sidebar-border bg-card">
          {pathname.startsWith("/dashboard/chat") ? (
            <DashboardSidebarChatPanel
              archivedChats={archivedChats}
              activeChatId={activeThreadId}
              onArchiveChat={archiveChat}
              onCreateChat={() => router.push("/dashboard/chat")}
              onDeleteChat={deleteChat}
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
          ) : (
            <GenericRoutePanel pathname={pathname} />
          )}
        </div>
      ) : null}
    </aside>
  );
}

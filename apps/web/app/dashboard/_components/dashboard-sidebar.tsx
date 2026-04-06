"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  CreditCard,
  FolderKanban,
  LayoutDashboard,
  MessageSquareText,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
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
    title: "Team",
    href: "/dashboard/team",
    icon: Users,
    match: (p) => p.startsWith("/dashboard/team"),
  },
  {
    title: "Billing",
    href: "/dashboard/billing",
    icon: CreditCard,
    match: (p) => p.startsWith("/dashboard/billing"),
  },
  {
    title: "Settings",
    href: "/dashboard/settings",
    icon: Settings,
    match: (p) => p.startsWith("/dashboard/settings"),
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
  {
    title: "Team",
    href: "/dashboard/team",
    description: "Organizations, members, invites.",
  },
  {
    title: "Billing",
    href: "/dashboard/billing",
    description: "Usage, subscriptions, ledger.",
  },
  {
    title: "Settings",
    href: "/dashboard/settings",
    description: "Sessions, providers, keys.",
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
    active && "border-border bg-card text-foreground shadow-xs",
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

function NavUser() {
  const authState = useAuthenticate();
  const user = authState.data?.user as
    | { email?: string; name?: string }
    | undefined;

  const initials = React.useMemo(() => {
    const v = user?.name || user?.email || "SW";
    return v
      .split(/\s+|@/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() || "")
      .join("");
  }, [user?.email, user?.name]);

  return (
    <button
      className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-xs"
      title={user?.email || "Account"}
      type="button"
    >
      {initials || "SW"}
    </button>
  );
}

function GenericRoutePanel({ pathname }: { pathname: string }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-card">
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
  const {
    activeChatId,
    archivedChats,
    archiveChat,
    createChat,
    deleteChat,
    openChat,
    privateChats,
    setWorkspaceName,
    sharedChats,
    workspaceName,
  } = useDashboardChatState();

  return (
    <aside className="hidden h-svh w-[360px] shrink-0 border-r border-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border px-2 py-4">
        <div className="flex flex-col items-center gap-2">
          <a
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs"
            href="/dashboard"
            title="SourceWeft"
          >
            <Sparkles className="h-4.5 w-4.5" />
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

        <NavUser />
      </div>

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-r border-sidebar-border bg-card">
        {pathname.startsWith("/dashboard/chat") ? (
          <DashboardSidebarChatPanel
            archivedChats={archivedChats}
            activeChatId={activeChatId}
            onArchiveChat={archiveChat}
            onCreateChat={() => createChat()}
            onDeleteChat={deleteChat}
            onOpenChat={openChat}
            privateChats={privateChats}
            sharedChats={sharedChats}
            onWorkspaceChange={setWorkspaceName}
            workspaceName={workspaceName}
          />
        ) : (
          <GenericRoutePanel pathname={pathname} />
        )}
      </div>
    </aside>
  );
}

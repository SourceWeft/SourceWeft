import { useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock3,
  MoreHorizontal,
  PenSquare,
  Share2,
  Trash2,
} from "lucide-react";
import { Logo } from "@sourceweft/ui-web/logo";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuItem,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { workspaceSummary, type ChatItem } from "../chat/_components/mock-data";

const workspaces = [
  "AI Research Desk",
  "Product Positioning",
  "Customer Insights",
];

function WorkspaceSwitcher({
  activeWorkspace,
  onWorkspaceChange,
}: {
  activeWorkspace: string;
  onWorkspaceChange: (workspace: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex w-full min-w-36 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
          type="button"
        >
          <span className="flex-1 truncate font-medium text-left">{activeWorkspace}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-64 rounded-lg"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((workspace, index) => (
          <DropdownMenuItem
            key={workspace}
            onClick={() => onWorkspaceChange(workspace)}
            className="gap-2 p-2"
          >
            <span className="flex-1 truncate text-left">{workspace}</span>
            <span className="text-xs text-muted-foreground">⌘{index + 1}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 p-2">
          <span className="flex-1 truncate font-medium text-muted-foreground text-left">
            Add workspace
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusDot({ status }: { status?: ChatItem["status"] }) {
  return (
    <span
      className={cn(
        "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
        status === "running"
          ? "bg-amber-500"
          : status === "attention"
            ? "bg-red-500"
            : "bg-emerald-500",
      )}
    />
  );
}

function ChatListRow({
  active,
  canArchive = true,
  item,
  onArchive,
  onDelete,
  onOpen,
}: {
  active: boolean;
  canArchive?: boolean;
  item: ChatItem;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string, title: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <SidebarMenuItem className="relative px-2">
      <button
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-auto w-full items-start gap-2 px-3 py-2 text-left text-sm leading-snug transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
        onClick={() => onOpen(item.id, item.title)}
        type="button"
      >
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="flex w-full items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="relative min-w-0 pr-12">
                <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-4.5">
                  {item.title}
                </span>
                <span
                  className={cn(
                    "pointer-events-none absolute right-0 top-0 shrink-0 text-[10px] leading-4 text-muted-foreground/80 transition-opacity",
                    "group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0",
                    menuOpen && "opacity-0",
                  )}
                >
                  {item.updatedAt}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
                <span>{item.sourceCount} sources</span>
                <span aria-hidden="true">·</span>
                <span>{item.status || "ready"}</span>
              </div>
            </div>
          </div>
        </div>
      </button>

      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-1.5 right-2.5 w-12 rounded-r-md bg-gradient-to-l from-sidebar via-sidebar/70 to-transparent invisible opacity-0 transition-opacity",
          "group-hover/menu-item:visible group-hover/menu-item:opacity-100 group-focus-within/menu-item:visible group-focus-within/menu-item:opacity-100",
          menuOpen && "visible opacity-100",
        )}
      />
      <div
        className={cn(
          "absolute right-3 top-2 z-10 shrink-0 invisible opacity-0 pointer-events-none transition-opacity",
          "group-hover/menu-item:visible group-hover/menu-item:opacity-100 group-hover/menu-item:pointer-events-auto group-focus-within/menu-item:visible group-focus-within/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto",
          menuOpen && "visible opacity-100 pointer-events-auto",
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              className="size-7 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Open chat actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {canArchive ? (
              <DropdownMenuItem onSelect={() => onArchive(item.id)}>
                <Archive className="size-4" />
                <span>Archive</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() => onDelete(item.id)}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              <span>Delete</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SidebarMenuItem>
  );
}

function ChatSection({
  activeId,
  canArchive = true,
  items,
  onArchive,
  onDelete,
  onOpen,
  title,
}: {
  activeId?: string;
  canArchive?: boolean;
  items: ChatItem[];
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string, title: string) => void;
  title: string;
}) {
  return (
    <SidebarGroup className="px-0">
      <SidebarGroupLabel className="h-6 px-3.5 text-[10px] uppercase tracking-[0.16em]">
        {title}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1 py-0.5">
          {items.map((item) => (
            <ChatListRow
              key={item.id}
              active={item.id === activeId}
              canArchive={canArchive}
              item={item}
              onArchive={onArchive}
              onDelete={onDelete}
              onOpen={onOpen}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function DashboardSidebarChatPanel({
  archivedChats,
  activeChatId,
  onArchiveChat,
  onCreateChat,
  onDeleteChat,
  onOpenChat,
  privateChats,
  sharedChats,
  onWorkspaceChange,
  workspaceName,
}: {
  archivedChats: ChatItem[];
  activeChatId: string;
  onArchiveChat: (id: string) => void;
  onCreateChat: () => void;
  onDeleteChat: (id: string) => void;
  onOpenChat: (id: string, title: string) => void;
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  onWorkspaceChange: (workspaceName: string) => void;
  workspaceName: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader className="gap-2.5 border-b px-3.5 py-2.5">
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {workspaceSummary.organizationName}
          </span>
        </div>
        <WorkspaceSwitcher
          activeWorkspace={workspaceName}
          onWorkspaceChange={onWorkspaceChange}
        />
        <SidebarInput className="h-7 text-xs" placeholder="Search threads..." />
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={onCreateChat}
            size="xs"
            type="button"
          >
            <PenSquare className="size-3" />
            New chat
          </Button>
          <Button size="icon-xs" type="button" variant="outline">
            <Share2 className="size-3" />
            <span className="sr-only">Share</span>
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="min-h-0 overflow-y-auto">
        <ChatSection
          activeId={activeChatId}
          items={sharedChats}
          onArchive={onArchiveChat}
          onDelete={onDeleteChat}
          onOpen={onOpenChat}
          title="Shared chats"
        />
        <ChatSection
          activeId={activeChatId}
          items={privateChats}
          onArchive={onArchiveChat}
          onDelete={onDeleteChat}
          onOpen={onOpenChat}
          title="Private chats"
        />
        <ChatSection
          activeId={activeChatId}
          canArchive={false}
          items={archivedChats}
          onArchive={onArchiveChat}
          onDelete={onDeleteChat}
          onOpen={onOpenChat}
          title="Archived"
        />
      </SidebarContent>

      <SidebarFooter className="border-t px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock3 className="size-3.5" />
          <span>7 threads this week</span>
        </div>
      </SidebarFooter>
    </div>
  );
}

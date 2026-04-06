import { Archive, Clock3, PenSquare, Share2, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { workspaceSummary, type ChatItem } from "../chat/_components/mock-data";

const workspaces = [
  "AI Research Desk",
  "Product Positioning",
  "Customer Insights",
];

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

function ChatSection({
  activeId,
  items,
  onArchive,
  onDelete,
  onOpen,
  title,
}: {
  activeId?: string;
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
        {items.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(item.id, item.title)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(item.id, item.title);
              }
            }}
            className={cn(
              "group flex w-full cursor-pointer items-start gap-2.5 border-b px-3.5 py-2 text-left text-sm leading-tight last:border-b-0 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              item.id === activeId &&
                "bg-sidebar-accent/60 shadow-[inset_2px_0_0_0_hsl(var(--primary))]",
            )}
          >
            <StatusDot status={item.status} />
            <div className="min-w-0 flex-1">
              <div className="flex w-full items-center gap-2">
                <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-5">
                  {item.title}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {item.updatedAt}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{item.sourceCount} sources</span>
                <span>·</span>
                <span>{item.status || "ready"}</span>
              </div>

              <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <Button
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onArchive(item.id);
                  }}
                  size="icon-xs"
                  type="button"
                  variant="outline"
                >
                  <Archive className="size-3" />
                  <span className="sr-only">Archive</span>
                </Button>
                <Button
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onDelete(item.id);
                  }}
                  size="icon-xs"
                  type="button"
                  variant="outline"
                >
                  <Trash2 className="size-3" />
                  <span className="sr-only">Delete</span>
                </Button>
              </div>
            </div>
          </div>
        ))}
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
  const currentIndex = Math.max(0, workspaces.indexOf(workspaceName));
  const nextWorkspace =
    workspaces[(currentIndex + 1) % workspaces.length] ||
    workspaces[0] ||
    "AI Research Desk";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader className="gap-2.5 border-b px-3.5 py-2.5">
        <div className="flex w-full items-center justify-between gap-2">
          <button
            className="truncate text-left text-sm font-semibold text-foreground"
            onClick={() => onWorkspaceChange(nextWorkspace)}
            type="button"
            title="Switch workspace"
          >
            {workspaceName}
          </button>
          <span className="text-[10px] text-muted-foreground">
            {workspaceSummary.organizationName}
          </span>
        </div>
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

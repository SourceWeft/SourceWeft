import { useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock3,
  MoreHorizontal,
  PanelsTopLeft,
  PenSquare,
  Share2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sourceweft/ui-web/components/ui/dialog";
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
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatShortRelativeTime } from "../../../lib/relative-time";
import { workspaceSummary, type ChatItem } from "../chat/_components/mock-data";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function WorkspaceSwitcher({
  workspaceId,
  activeWorkspace,
  workspaces,
  onCreateWorkspace,
  onRenameWorkspace,
  onWorkspaceChange,
}: {
  workspaceId: string | null;
  activeWorkspace: string;
  workspaces: Array<{ id: string; name: string }>;
  onCreateWorkspace: (name: string) => Promise<void>;
  onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  onWorkspaceChange: (workspaceId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const activeWorkspaceRecord =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  const handleCreateWorkspace = async () => {
    const name = workspaceNameInput.trim();
    if (!name || isSaving) return;

    setIsSaving(true);
    try {
      await onCreateWorkspace(name);
      setWorkspaceNameInput("");
      setCreateOpen(false);
    } catch {
      toast.error("Failed to create workspace.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRenameWorkspace = async () => {
    const name = workspaceNameInput.trim();
    if (!workspaceId || !name || isSaving) return;

    setIsSaving(true);
    try {
      await onRenameWorkspace(workspaceId, name);
      setWorkspaceNameInput("");
      setRenameOpen(false);
    } catch {
      toast.error("Failed to rename workspace.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex w-full min-w-36 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
            type="button"
          >
            <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" />
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
              key={workspace.id}
              onClick={() => onWorkspaceChange(workspace.id)}
              className={cn("gap-2 p-2", workspace.id === workspaceId && "bg-accent/60")}
            >
              <span className="flex-1 truncate text-left">{workspace.name}</span>
              <span className="text-xs text-muted-foreground">⌘{index + 1}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 p-2"
            disabled={!activeWorkspaceRecord}
            onSelect={() => {
              setWorkspaceNameInput(activeWorkspaceRecord?.name ?? activeWorkspace);
              setRenameOpen(true);
            }}
          >
            <span className="flex-1 truncate font-medium text-left">
              Rename workspace
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 p-2"
            onSelect={() => {
              setWorkspaceNameInput(`Workspace ${workspaces.length + 1}`);
              setCreateOpen(true);
            }}
          >
            <span className="flex-1 truncate font-medium text-left">
              Add workspace
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add workspace</DialogTitle>
            <DialogDescription>
              Create a workspace to keep sources and chats in a separate context.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            onChange={(event) => setWorkspaceNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void handleCreateWorkspace();
              }
            }}
            placeholder="Workspace name"
            value={workspaceNameInput}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!workspaceNameInput.trim() || isSaving}
              onClick={() => void handleCreateWorkspace()}
              type="button"
            >
              {isSaving ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Update the display name for this workspace.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            onChange={(event) => setWorkspaceNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void handleRenameWorkspace();
              }
            }}
            placeholder="Workspace name"
            value={workspaceNameInput}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!workspaceNameInput.trim() || isSaving}
              onClick={() => void handleRenameWorkspace()}
              type="button"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  onDelete: (id: string) => Promise<void>;
  onOpen: (id: string, title: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = item.status || "ready";
  const relativeUpdatedAt = formatShortRelativeTime(item.updatedAt);

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
              <div className="relative min-w-0 pr-8">
                <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-4.5">
                  {item.title}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
                <span>{item.sourceCount} sources</span>
                <span aria-hidden="true">|</span>
                <span>{status}</span>
                <span aria-hidden="true">|</span>
                <span>{relativeUpdatedAt}</span>
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
              onSelect={() => void onDelete(item.id)}
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
  hasMore = false,
  isLoadingMore = false,
  items,
  onLoadMore,
  onArchive,
  onClear,
  onDelete,
  onOpen,
  title,
}: {
  activeId?: string;
  canArchive?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  items: ChatItem[];
  onLoadMore?: () => void;
  onArchive: (id: string) => void;
  onClear?: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpen: (id: string, title: string) => void;
  title: string;
}) {
  const [isClearing, setIsClearing] = useState(false);

  const handleClear = async () => {
    if (!onClear || isClearing) return;

    setIsClearing(true);
    try {
      await onClear();
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <SidebarGroup className="px-0">
      <SidebarGroupLabel className="group/section-label flex h-6 items-center justify-between px-3.5 text-[10px] uppercase tracking-[0.16em]">
        <span>{title}</span>
        {onClear && items.length > 0 ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                className="invisible size-5 pointer-events-none text-destructive opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:visible focus-visible:pointer-events-auto focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:opacity-100 group-hover/section-label:visible group-hover/section-label:pointer-events-auto group-hover/section-label:opacity-100 group-focus-within/section-label:visible group-focus-within/section-label:pointer-events-auto group-focus-within/section-label:opacity-100"
                size="icon-xs"
                title={`Clear all ${title.toLowerCase()}`}
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3" />
                <span className="sr-only">Clear all {title.toLowerCase()}</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear all {title.toLowerCase()}?</DialogTitle>
                <DialogDescription>
                  This will remove {items.length}{" "}
                  {items.length === 1 ? "chat" : "chats"}
                  from this section. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button
                    disabled={isClearing}
                    onClick={() => void handleClear()}
                    type="button"
                    variant="destructive"
                  >
                    {isClearing ? "Clearing..." : "Clear all"}
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
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
        {hasMore && onLoadMore ? (
          <div className="px-3.5 py-1.5">
            <Button
              className="h-auto w-full justify-center px-0 py-1 text-[11px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              size="xs"
              type="button"
              variant="ghost"
            >
              {isLoadingMore ? "Loading..." : "Load more"}
            </Button>
          </div>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function DashboardSidebarChatPanel({
  archivedChats,
  activeChatId,
  onArchiveChat,
  onClearArchivedChats,
  onClearPrivateChats,
  onCreateChat,
  onDeleteChat,
  onLoadMoreChats,
  onOpenChat,
  onCreateWorkspace,
  onRenameWorkspace,
  hasMorePrivateChats,
  isLoadingPrivateChats,
  privateChats,
  sharedChats,
  workspaceId,
  workspaces,
  onWorkspaceChange,
  workspaceName,
}: {
  archivedChats: ChatItem[];
  activeChatId: string;
  onArchiveChat: (id: string) => void;
  onClearArchivedChats: () => Promise<void>;
  onClearPrivateChats: () => Promise<void>;
  onCreateChat: () => void;
  onDeleteChat: (id: string) => Promise<void>;
  onLoadMoreChats: () => void;
  onOpenChat: (id: string, title: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  hasMorePrivateChats: boolean;
  isLoadingPrivateChats: boolean;
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  workspaceId: string | null;
  workspaces: Array<{ id: string; name: string }>;
  onWorkspaceChange: (workspaceId: string) => void;
  workspaceName: string;
}) {
  const weekAgo = Date.now() - ONE_WEEK_MS;
  const seenIds = new Set<string>();
  const threadsThisWeek = [...sharedChats, ...privateChats, ...archivedChats].reduce(
    (count, item) => {
      if (seenIds.has(item.id)) {
        return count;
      }

      seenIds.add(item.id);
      const updatedAt = new Date(item.updatedAt);
      if (Number.isNaN(updatedAt.getTime())) {
        return count;
      }

      return updatedAt.getTime() >= weekAgo ? count + 1 : count;
    },
    0,
  );

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
          workspaceId={workspaceId}
          workspaces={workspaces}
          onCreateWorkspace={onCreateWorkspace}
          onRenameWorkspace={onRenameWorkspace}
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
          hasMore={hasMorePrivateChats}
          isLoadingMore={isLoadingPrivateChats}
          items={privateChats}
          onLoadMore={onLoadMoreChats}
          onArchive={onArchiveChat}
          onClear={onClearPrivateChats}
          onDelete={onDeleteChat}
          onOpen={onOpenChat}
          title="Private chats"
        />
        <ChatSection
          activeId={activeChatId}
          canArchive={false}
          items={archivedChats}
          onArchive={onArchiveChat}
          onClear={onClearArchivedChats}
          onDelete={onDeleteChat}
          onOpen={onOpenChat}
          title="Archived"
        />
      </SidebarContent>

      <SidebarFooter className="border-t px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock3 className="size-3.5" />
          <span>
            {threadsThisWeek} {threadsThisWeek === 1 ? "thread" : "threads"} this week
          </span>
        </div>
      </SidebarFooter>
    </div>
  );
}

"use client";
import { useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Link2,
  ListFilter,
  MessagesSquare,
  X,
  ChevronDown,
  Search,
  Lock,
  MoreHorizontal,
  PanelsTopLeft,
  PenSquare,
  Share2,
  Trash2,
  Users,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuItem,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";
import {
  getSidebarChatItems,
  type ChatVisibilityFilter,
} from "./dashboard-sidebar-chat-list";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatShortRelativeTime } from "../../../lib/relative-time";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  formatDashboardShortcut,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcutPlatform,
} from "./dashboard-shortcuts";
import { isSharedChat, type ChatItem } from "./dashboard-chat-types";

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
  const shortcutPlatform = useDashboardShortcutPlatform();

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
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
            type="button"
          >
            <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-medium text-left">
              {activeWorkspace}
            </span>
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
              className={cn(
                "gap-2 p-2",
                workspace.id === workspaceId && "bg-accent/60",
              )}
            >
              <span className="flex-1 truncate text-left">
                {workspace.name}
              </span>
              {index < DASHBOARD_WORKSPACE_SHORTCUT_LIMIT ? (
                <span className="text-xs text-muted-foreground">
                  {formatDashboardShortcut(
                    getDashboardWorkspaceShortcutKeys(index, shortcutPlatform),
                  )}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 p-2"
            disabled={!activeWorkspaceRecord}
            onSelect={() => {
              setWorkspaceNameInput(
                activeWorkspaceRecord?.name ?? activeWorkspace,
              );
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
              Create a workspace to keep sources and chats in a separate
              context.
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
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
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
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameOpen(false)}
            >
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
  onSetVisibility,
  onOpen,
  onPrefetch,
}: {
  active: boolean;
  canArchive?: boolean;
  item: ChatItem;
  onArchive: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onSetVisibility?: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onOpen: (id: string, title: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = item.status || "ready";
  const relativeUpdatedAt = formatShortRelativeTime(item.updatedAt);
  const shared = isSharedChat(item);

  const handleToggleVisibility = async () => {
    if (!onSetVisibility) return;
    try {
      await onSetVisibility(item.id, shared ? "private" : "workspace");
      toast.success(
        shared ? "Chat is now private" : "Chat is now visible to the workspace",
      );
    } catch {
      toast.error("Could not change who can see this chat.");
    }
  };

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
        onFocus={() => onPrefetch?.(item.id)}
        onMouseEnter={() => onPrefetch?.(item.id)}
        type="button"
      >
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="flex w-full items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="relative flex min-w-0 items-center gap-2 pr-8">
                <span className="line-clamp-1 min-w-0 flex-1 text-[13px] font-medium leading-4.5">
                  {item.title}
                </span>
                {shared ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 text-muted-foreground">
                        {item.visibility === "public_link" ? (
                          <Link2 className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Users className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {item.visibility === "public_link"
                            ? "Anyone with the link"
                            : "Visible to workspace"}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {item.visibility === "public_link"
                        ? "Anyone with the link"
                        : "Visible to workspace"}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
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
          "pointer-events-none absolute inset-y-1.5 right-2.5 w-8 rounded-r-md bg-gradient-to-l from-sidebar via-sidebar/70 to-transparent invisible opacity-0 transition-opacity",
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
          <DropdownMenuContent align="end" className="w-52">
            {onSetVisibility ? (
              <DropdownMenuItem onSelect={() => void handleToggleVisibility()}>
                {shared ? (
                  <>
                    <Lock className="size-4" />
                    <span>Make private</span>
                  </>
                ) : (
                  <>
                    <Users className="size-4" />
                    <span>Make visible to workspace</span>
                  </>
                )}
              </DropdownMenuItem>
            ) : null}
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

function ChatList({
  search,
  headerActions,
  activeId,
  hasMore = false,
  isLoadingMore = false,
  privateChats,
  sharedChats,
  archivedChats,
  onLoadMore,
  onArchive,
  onClearPrivate,
  onClearArchived,
  onDelete,
  onSetVisibility,
  onOpen,
  onPrefetch,
}: {
  search: string;
  headerActions: ReactNode;
  activeId?: string;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  archivedChats: ChatItem[];
  onLoadMore?: () => void;
  onArchive: (id: string) => void;
  onClearPrivate: () => Promise<void>;
  onClearArchived: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSetVisibility?: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onOpen: (id: string, title: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const [isClearing, setIsClearing] = useState(false);
  const [view, setView] = useState<"chats" | "archived">("chats");
  const [filter, setFilter] = useState<ChatVisibilityFilter>("all");
  const isArchived = view === "archived";
  const items = useMemo(
    () =>
      getSidebarChatItems({
        privateChats,
        sharedChats,
        archivedChats,
        view,
        filter,
      }).filter((item) =>
        item.title.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [privateChats, sharedChats, archivedChats, view, filter, search],
  );
  const canLoadMore = !isArchived && hasMore;
  // Clear actions keep their original scope, regardless of the visible subset.
  const onClear = search.trim()
    ? undefined
    : isArchived
      ? onClearArchived
      : filter === "private"
        ? onClearPrivate
        : undefined;
  const clearItems = isArchived ? archivedChats : privateChats;
  const clearTitle = isArchived ? "archived chats" : "private chats";
  const switchView = (nextView: "chats" | "archived") => {
    setView(nextView);
    setFilter("all");
  };

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
    <>
      <div className="group/section-label flex shrink-0 items-center gap-1 px-3.5 py-2">
        {isArchived ? (
          <Button
            onClick={() => switchView("chats")}
            size="icon-xs"
            type="button"
            variant="ghost"
            aria-label="Back to chats"
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        ) : null}
        <span className="flex-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {isArchived ? "Archived" : "Chats"}
        </span>
        {headerActions}
        {onClear && clearItems.length > 0 ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                className="invisible size-5 pointer-events-none text-destructive opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:visible focus-visible:pointer-events-auto focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:opacity-100 group-hover/section-label:visible group-hover/section-label:pointer-events-auto group-hover/section-label:opacity-100 group-focus-within/section-label:visible group-focus-within/section-label:pointer-events-auto group-focus-within/section-label:opacity-100"
                size="icon-xs"
                title={`Clear all ${clearTitle}`}
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3" />
                <span className="sr-only">Clear all {clearTitle}</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear all {clearTitle}?</DialogTitle>
                <DialogDescription>
                  This will remove {clearItems.length} {clearTitle}, including
                  chats hidden by the current filter. This action cannot be
                  undone.
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
        {filter !== "all" ? (
          <Button
            className="h-6 gap-1 rounded px-1.5 text-[11px]"
            onClick={() => setFilter("all")}
            size="xs"
            type="button"
            variant="secondary"
            aria-label={`Clear ${filter} filter`}
          >
            {filter === "shared" ? "Shared" : "Private"}
            <X className="size-3" />
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={cn(
                "text-muted-foreground",
                filter !== "all" &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              size="icon-xs"
              type="button"
              variant="ghost"
              title="Filter chats"
              aria-label="Filter chats"
            >
              <ListFilter className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Visibility
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => {
                if (
                  value === "all" ||
                  value === "shared" ||
                  value === "private"
                ) {
                  setFilter(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="all">
                <MessagesSquare className="size-4" />
                All chats
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="shared">
                <Users className="size-4" />
                Shared
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="private">
                <Lock className="size-4" />
                Private
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SidebarContent
        key={`${view}-${filter}`}
        className="min-h-0 overflow-y-auto"
      >
        <SidebarGroup className="px-0 pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1 py-0.5">
              {items.map((item) => (
                <ChatListRow
                  key={item.id}
                  active={item.id === activeId}
                  canArchive={!isArchived}
                  item={item}
                  onArchive={onArchive}
                  onDelete={onDelete}
                  onSetVisibility={isArchived ? undefined : onSetVisibility}
                  onOpen={onOpen}
                  onPrefetch={onPrefetch}
                />
              ))}
            </SidebarMenu>
            {items.length === 0 ? (
              <p
                className="px-3.5 py-4 text-xs text-muted-foreground"
                role="status"
              >
                {isLoadingMore && !isArchived
                  ? "Loading chats..."
                  : canLoadMore
                    ? "No matching chats loaded. Load more to see older chats."
                    : filter !== "all"
                      ? `No ${filter} chats${isArchived ? " in archive" : ""}.`
                      : isArchived
                        ? "No archived chats."
                        : "No chats yet."}
              </p>
            ) : null}
            {canLoadMore && onLoadMore ? (
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
      </SidebarContent>
      {!isArchived ? (
        <div className="shrink-0 border-t px-3.5 py-1.5">
          <Button
            className="w-full justify-start gap-2 text-xs text-muted-foreground"
            onClick={() => switchView("archived")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Archive className="size-3.5" />
            <span className="flex-1 text-left">Archived</span>
            {archivedChats.length > 0 ? (
              <span className="text-[11px] tabular-nums">
                {archivedChats.length}
              </span>
            ) : null}
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function DashboardSidebarChatPanel({
  heading,
  navigation,
  footer,
  search,
  onSearchChange,
  archivedChats,
  activeChatId,
  onArchiveChat,
  onClearArchivedChats,
  onClearPrivateChats,
  onCreateChat,
  onDeleteChat,
  onSetChatVisibility,
  onLoadMoreChats,
  onOpenMembers,
  onOpenChat,
  onPrefetchChat,
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
  heading: ReactNode;
  navigation: ReactNode;
  footer: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  archivedChats: ChatItem[];
  activeChatId: string;
  onArchiveChat: (id: string) => void;
  onClearArchivedChats: () => Promise<void>;
  onClearPrivateChats: () => Promise<void>;
  onCreateChat: () => void;
  onDeleteChat: (id: string) => Promise<void>;
  onSetChatVisibility: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onLoadMoreChats: () => void;
  onOpenMembers?: () => void;
  onOpenChat: (id: string, title: string) => void;
  onPrefetchChat?: (id: string) => void;
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
  const [chatListResetKey, setChatListResetKey] = useState(0);

  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader className="shrink-0 gap-1 px-3 pb-2 pt-0">
        <div className="flex h-12 min-w-0 items-center gap-1 sm:h-14">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher
              activeWorkspace={workspaceName}
              workspaceId={workspaceId}
              workspaces={workspaces}
              onCreateWorkspace={onCreateWorkspace}
              onRenameWorkspace={onRenameWorkspace}
              onWorkspaceChange={onWorkspaceChange}
            />
          </div>
          {heading}
        </div>
        <div className="flex items-center gap-1">
          <Button
            className="h-9 flex-1 justify-start gap-2 rounded-lg px-2 text-sm font-medium"
            variant="ghost"
            onClick={() => {
              setChatListResetKey((value) => value + 1);
              onCreateChat();
            }}
            size="xs"
            type="button"
          >
            <PenSquare className="size-4 text-muted-foreground" />
            New chat
          </Button>
          <Button
            className="size-9 shrink-0"
            variant="ghost"
            size="icon-xs"
            aria-label="Search all chats"
            aria-expanded={searchOpen || Boolean(search)}
            onClick={() => {
              setSearchOpen((value) => !value);
              onSearchChange("");
            }}
          >
            <Search className="size-4" />
          </Button>
        </div>
        {(searchOpen || search) && (
          <SidebarInput
            autoFocus
            aria-label="Search all chats"
            className="h-8 text-xs"
            placeholder="Search all chats…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        )}
      </SidebarHeader>
      {navigation}
      <ChatList
        key={`${workspaceId}-${chatListResetKey}`}
        search={search}
        headerActions={
          <Button
            onClick={onOpenMembers}
            size="icon-xs"
            title="Invite & manage members"
            type="button"
            variant="ghost"
          >
            <Share2 className="size-3" />
            <span className="sr-only">Invite & manage members</span>
          </Button>
        }
        activeId={activeChatId}
        hasMore={hasMorePrivateChats}
        isLoadingMore={isLoadingPrivateChats}
        privateChats={privateChats}
        sharedChats={sharedChats}
        archivedChats={archivedChats}
        onLoadMore={onLoadMoreChats}
        onArchive={onArchiveChat}
        onClearPrivate={onClearPrivateChats}
        onClearArchived={onClearArchivedChats}
        onDelete={onDeleteChat}
        onSetVisibility={onSetChatVisibility}
        onOpen={onOpenChat}
        onPrefetch={onPrefetchChat}
      />

      {footer}
    </div>
  );
}

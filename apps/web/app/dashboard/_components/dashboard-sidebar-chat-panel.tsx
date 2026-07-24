import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock3,
  Gauge,
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
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
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
import { authClient } from "../../../lib/auth-client";
import { billingClient } from "../../../lib/sdk";
import { formatShortRelativeTime } from "../../../lib/relative-time";
import { subscribeDashboardBillingSummaryRefresh } from "./dashboard-billing-summary-refresh";
import { getPersonalOrganization } from "./dashboard-team-selector-shared";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  formatDashboardShortcut,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcutPlatform,
} from "./dashboard-shortcuts";
import { isSharedChat, type ChatItem } from "./dashboard-chat-types";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;
type BillingOrg = {
  id: string;
  metadata?: unknown;
  name: string;
  slug?: string;
};

function resolveSidebarBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  return getPersonalOrganization(input.orgs ?? [])?.id ?? null;
}

function formatUsageNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function formatUsageDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}

function SidebarUsageSummary({ onOpenUsage }: { onOpenUsage?: () => void }) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;
  const orgList = (orgs ?? []) as BillingOrg[];
  const teamId = resolveSidebarBillingTeamId({
    activeOrg: activeOrgRecord,
    orgs: orgList,
  });
  const resolvingTeamId = !activeOrgRecord && orgs === undefined;
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSummary = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const silent = options?.silent === true;

      if (!teamId) {
        setSummary(null);
        setLoading(resolvingTeamId);
        setHasError(false);
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      setHasError(false);

      try {
        const nextSummary = await billingClient.getSummary(teamId);

        if (mountedRef.current && requestIdRef.current === requestId) {
          setSummary(nextSummary);
        }
      } catch {
        if (mountedRef.current && requestIdRef.current === requestId) {
          if (!silent) {
            setSummary(null);
          }
          setHasError(true);
        }
      } finally {
        if (mountedRef.current && requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [resolvingTeamId, teamId],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(
    () =>
      subscribeDashboardBillingSummaryRefresh(() => {
        void loadSummary({ silent: true });
      }),
    [loadSummary],
  );

  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const creditsPercent =
    creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : 0;
  const creditsLabel = summary
    ? `${formatUsageNumber(creditsUsed)} / ${formatUsageNumber(creditsLimit)}`
    : loading
      ? "Loading"
      : "-- / --";
  const pagesAvailable = summary?.pages.available ?? 0;
  const cycleEndsAt = summary ? formatUsageDate(summary.cycleEndAt) : "--";

  return (
    <button
      aria-label="Open usage"
      className="w-full rounded-lg border border-sidebar-border bg-sidebar-accent/35 p-2.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpenUsage}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Gauge className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[10px] font-medium text-sidebar-foreground">
            Usage
          </span>
        </div>
        <span className="shrink-0 text-[10px] font-medium text-sidebar-foreground">
          {summary ? `${Math.round(creditsPercent)}%` : loading ? "..." : "--"}
        </span>
      </div>

      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">Credits</span>
          <span className="truncate text-right font-medium text-sidebar-foreground">
            {creditsLabel}
          </span>
        </div>
        <Progress className="h-1 bg-sidebar-border/70" value={creditsPercent} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div className="min-w-0">
          <p className="truncate text-muted-foreground">Pages left</p>
          <p className="truncate font-medium text-sidebar-foreground">
            {summary
              ? formatUsageNumber(pagesAvailable)
              : loading
                ? "..."
                : "--"}
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate text-muted-foreground">Cycle ends</p>
          <p className="truncate font-medium text-sidebar-foreground">
            {hasError ? "Unavailable" : cycleEndsAt}
          </p>
        </div>
      </div>
    </button>
  );
}

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
            className="flex w-full min-w-36 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
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
        shared ? "Chat is now private" : "Chat shared with workspace",
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
              <div className="relative min-w-0 pr-8">
                <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-4.5">
                  {item.title}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
                {shared ? (
                  <>
                    <Users
                      className="size-2.5"
                      aria-label="Shared with workspace"
                    />
                    <span aria-hidden="true">|</span>
                  </>
                ) : null}
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
          <DropdownMenuContent align="end" className="w-44">
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
                    <span>Share with workspace</span>
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
  onSetVisibility,
  onOpen,
  onPrefetch,
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
  onSetVisibility?: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onOpen: (id: string, title: string) => void;
  onPrefetch?: (id: string) => void;
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
              onSetVisibility={onSetVisibility}
              onOpen={onOpen}
              onPrefetch={onPrefetch}
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
  onSetChatVisibility,
  onLoadMoreChats,
  onOpenUsage,
  onOpenChat,
  onPrefetchChat,
  onCreateWorkspace,
  onRenameWorkspace,
  hasMorePrivateChats,
  isLoadingPrivateChats,
  privateChats,
  sharedChats,
  organizationName,
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
  onSetChatVisibility: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onLoadMoreChats: () => void;
  onOpenUsage?: () => void;
  onOpenChat: (id: string, title: string) => void;
  onPrefetchChat?: (id: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  hasMorePrivateChats: boolean;
  isLoadingPrivateChats: boolean;
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  organizationName: string;
  workspaceId: string | null;
  workspaces: Array<{ id: string; name: string }>;
  onWorkspaceChange: (workspaceId: string) => void;
  workspaceName: string;
}) {
  const weekAgo = Date.now() - ONE_WEEK_MS;
  const seenIds = new Set<string>();
  const threadsThisWeek = [
    ...sharedChats,
    ...privateChats,
    ...archivedChats,
  ].reduce((count, item) => {
    if (seenIds.has(item.id)) {
      return count;
    }

    seenIds.add(item.id);
    const updatedAt = new Date(item.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      return count;
    }

    return updatedAt.getTime() >= weekAgo ? count + 1 : count;
  }, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader className="gap-2.5 border-b px-3.5 py-2.5">
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {organizationName}
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
          onSetVisibility={onSetChatVisibility}
          onOpen={onOpenChat}
          onPrefetch={onPrefetchChat}
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
          onSetVisibility={onSetChatVisibility}
          onOpen={onOpenChat}
          onPrefetch={onPrefetchChat}
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
          onPrefetch={onPrefetchChat}
          title="Archived"
        />
      </SidebarContent>

      <SidebarFooter className="border-t px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock3 className="size-3.5" />
          <span>
            {threadsThisWeek} {threadsThisWeek === 1 ? "thread" : "threads"}{" "}
            this week
          </span>
        </div>
      </SidebarFooter>

      <div className="border-t border-sidebar-border px-3.5 py-2.5">
        <SidebarUsageSummary onOpenUsage={onOpenUsage} />
      </div>
    </div>
  );
}

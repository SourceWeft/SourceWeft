"use client";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  Archive,
  Bot,
  ExternalLink,
  Link2,
  PanelRightOpen,
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
import type { Persona } from "@sourceweft/contracts";
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
  type SidebarChatFilter,
} from "./dashboard-sidebar-chat-list";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatShortRelativeTime } from "../../../lib/relative-time";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  formatDashboardShortcut,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcutPlatform,
} from "./dashboard-shortcuts";
import { contentClient } from "../../../lib/sdk";
import { isSharedChat, type ChatItem } from "./dashboard-chat-types";
import { DashboardPersonaManager } from "./dashboard-persona-manager";

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
  const t = useTranslations("dashboardNav");
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
      toast.error(t("workspace.createError"));
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
      toast.error(t("workspace.renameError"));
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
            {t("workspace.workspaces")}
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
              {t("workspace.rename")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 p-2"
            onSelect={() => {
              setWorkspaceNameInput(
                t("workspace.defaultName", {
                  number: workspaces.length + 1,
                }),
              );
              setCreateOpen(true);
            }}
          >
            <span className="flex-1 truncate font-medium text-left">
              {t("workspace.add")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workspace.add")}</DialogTitle>
            <DialogDescription>
              {t("workspace.addDescription")}
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
            placeholder={t("workspace.namePlaceholder")}
            value={workspaceNameInput}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!workspaceNameInput.trim() || isSaving}
              onClick={() => void handleCreateWorkspace()}
              type="button"
            >
              {isSaving ? t("workspace.creating") : t("workspace.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workspace.rename")}</DialogTitle>
            <DialogDescription>
              {t("workspace.renameDescription")}
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
            placeholder={t("workspace.namePlaceholder")}
            value={workspaceNameInput}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!workspaceNameInput.trim() || isSaving}
              onClick={() => void handleRenameWorkspace()}
              type="button"
            >
              {isSaving ? t("workspace.saving") : t("workspace.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Picks the persona that will own a new thread. Used both for a top-level
 * agent chat and for a sub-agent nested under a parent; the caller decides
 * where the thread goes, the dialog only chooses who drives it.
 */
function PersonaPickerDialog({
  onManage,
  onOpenChange,
  onPick,
  open,
  parentTitle,
  refreshToken,
  workspaceId,
}: {
  /** Opens the persona manager; the picker refetches when it closes. */
  onManage: () => void;
  onOpenChange: (open: boolean) => void;
  onPick: (personaId: string) => Promise<void>;
  open: boolean;
  parentTitle: string | null;
  /** Bumped whenever a persona was created, edited, or removed. */
  refreshToken: number;
  workspaceId: string | null;
}) {
  const t = useTranslations("dashboardNav.personaPicker");
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [pickingSlug, setPickingSlug] = useState<string | null>(null);

  // Personas are fetched whenever the picker opens, so an agent authored in
  // the manager a moment ago is already listed.
  const loadPersonas = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    setIsLoading(true);
    setHasError(false);
    try {
      const result = await contentClient.listPersonas(workspaceId);
      setPersonas(result.items);
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open && workspaceId) {
      void loadPersonas();
    }
    // refreshToken is a deliberate dependency: it forces a refetch after edits.
  }, [loadPersonas, open, refreshToken, workspaceId]);

  const handlePick = async (persona: Persona) => {
    if (pickingSlug) return;
    setPickingSlug(persona.id);
    try {
      await onPick(persona.id);
      onOpenChange(false);
    } catch {
      toast.error(t("couldNotStart"));
    } finally {
      setPickingSlug(null);
    }
  };

  const builtIn = personas?.filter((persona) => persona.trust === "system");
  const custom = personas?.filter((persona) => persona.trust !== "system");

  const renderPersona = (persona: Persona) => (
    <button
      key={persona.id}
      className="flex w-full items-start gap-2.5 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      disabled={pickingSlug !== null}
      onClick={() => void handlePick(persona)}
      type="button"
    >
      <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">
            {pickingSlug === persona.id
              ? t("starting", { name: persona.name })
              : persona.name}
          </span>
          {persona.trust !== "system" ? (
            <span className="shrink-0 rounded-sm border border-border px-1.5 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
              {t("custom")}
            </span>
          ) : null}
        </span>
        <span className="line-clamp-2 block text-xs text-muted-foreground">
          {persona.description}
        </span>
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {parentTitle ? t("addSubagentTitle") : t("newAgentChatTitle")}
          </DialogTitle>
          <DialogDescription>
            {parentTitle
              ? t("subagentDescription", { title: parentTitle })
              : t("defaultDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
          {isLoading && !personas ? (
            <p className="text-xs text-muted-foreground">
              {t("loadingAgents")}
            </p>
          ) : null}
          {hasError ? (
            <p className="text-xs text-destructive">
              {t("couldNotLoadAgents")}
            </p>
          ) : null}
          {builtIn?.map(renderPersona)}
          {custom && custom.length > 0 ? (
            <p className="mt-2 px-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {t("yourAgentsLabel")}
            </p>
          ) : null}
          {custom?.map(renderPersona)}
        </div>
        <DialogFooter className="sm:justify-start">
          <Button onClick={onManage} size="sm" type="button" variant="ghost">
            <PenSquare className="size-3.5" />
            {t("manageAgents")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  nested = false,
  onAddSubagent,
  onArchive,
  onDelete,
  onOpenInNewWindow,
  onOpenInPanel,
  onSetVisibility,
  onOpen,
  onPrefetch,
}: {
  active: boolean;
  canArchive?: boolean;
  item: ChatItem;
  /** A sub-agent conversation rendered under its parent row. */
  nested?: boolean;
  onAddSubagent?: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onOpenInNewWindow?: (id: string) => void;
  /** Opens a nested conversation beside its parent (parent id, child id). */
  onOpenInPanel?: (parentId: string, childId: string) => void;
  onSetVisibility?: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onOpen: (id: string, title: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const t = useTranslations("dashboardNav");
  const [menuOpen, setMenuOpen] = useState(false);
  const status = item.status || "ready";
  const relativeUpdatedAt = formatShortRelativeTime(item.updatedAt);
  const shared = isSharedChat(item);
  const parentThreadId = item.parentThreadId;

  const handleToggleVisibility = async () => {
    if (!onSetVisibility) return;
    try {
      await onSetVisibility(item.id, shared ? "private" : "workspace");
      toast.success(
        shared ? t("chats.nowPrivate") : t("chats.nowVisible"),
      );
    } catch {
      toast.error(t("chats.visibilityError"));
    }
  };

  return (
    <SidebarMenuItem className={cn("relative px-2", nested && "pl-6")}>
      <button
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-auto w-full items-start gap-2 px-3 py-2 text-left text-sm leading-snug transition-colors",
          nested && "py-1.5",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground group-hover/menu-item:bg-sidebar-accent/60 group-hover/menu-item:text-sidebar-accent-foreground group-focus-within/menu-item:bg-sidebar-accent/60",
          menuOpen && !active && "bg-sidebar-accent/60",
        )}
        onClick={() => onOpen(item.id, item.title)}
        onFocus={() => onPrefetch?.(item.id)}
        onMouseEnter={() => onPrefetch?.(item.id)}
        type="button"
      >
        <StatusDot status={item.status} />
        {nested ? (
          <span
            aria-hidden="true"
            className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground/70"
          >
            ↳
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex w-full items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="relative flex min-w-0 items-center gap-2 pr-8">
                <span
                  className={cn(
                    "line-clamp-1 min-w-0 flex-1 font-medium leading-4.5",
                    nested ? "text-[12px]" : "text-[13px]",
                  )}
                >
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
                            ? t("chats.anyoneWithLink")
                            : t("chats.visibleToWorkspace")}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {item.visibility === "public_link"
                        ? t("chats.anyoneWithLink")
                        : t("chats.visibleToWorkspace")}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
                <span>
                  {t("chats.sourceCount", { count: item.sourceCount })}
                </span>
                <span aria-hidden="true">|</span>
                <span>{t(`chats.status.${status}`)}</span>
                <span aria-hidden="true">|</span>
                <span>{relativeUpdatedAt}</span>
              </div>
            </div>
          </div>
        </div>
      </button>

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
              <span className="sr-only">{t("chats.openActions")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {onSetVisibility ? (
              <DropdownMenuItem onSelect={() => void handleToggleVisibility()}>
                {shared ? (
                  <>
                    <Lock className="size-4" />
                    <span>{t("chats.makePrivate")}</span>
                  </>
                ) : (
                  <>
                    <Users className="size-4" />
                    <span>{t("chats.makeVisible")}</span>
                  </>
                )}
              </DropdownMenuItem>
            ) : null}
            {!nested && onAddSubagent ? (
              <DropdownMenuItem
                onSelect={() => onAddSubagent(item.id, item.title)}
              >
                <Bot className="size-4" />
                <span>{t("chats.addSubagent")}</span>
              </DropdownMenuItem>
            ) : null}
            {nested && onOpenInPanel && parentThreadId ? (
              <DropdownMenuItem
                onSelect={() => onOpenInPanel(parentThreadId, item.id)}
              >
                <PanelRightOpen className="size-4" />
                <span>{t("chats.openBesideParent")}</span>
              </DropdownMenuItem>
            ) : null}
            {onOpenInNewWindow ? (
              <DropdownMenuItem onSelect={() => onOpenInNewWindow(item.id)}>
                <ExternalLink className="size-4" />
                <span>{t("chats.openInNewWindow")}</span>
              </DropdownMenuItem>
            ) : null}
            {canArchive ? (
              <DropdownMenuItem onSelect={() => onArchive(item.id)}>
                <Archive className="size-4" />
                <span>{t("chats.archive")}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() => void onDelete(item.id)}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              <span>{t("chats.delete")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SidebarMenuItem>
  );
}

function ChatList({
  search,
  searchOpen,
  onToggleSearch,
  onSearchChange,
  headerActions,
  activeId,
  hasMore = false,
  isLoadingMore = false,
  privateChats,
  sharedChats,
  archivedChats,
  onLoadMore,
  onAddSubagent,
  onArchive,
  onClearPrivate,
  onClearArchived,
  onDelete,
  onOpenInNewWindow,
  onOpenInPanel,
  onSetVisibility,
  onOpen,
  onPrefetch,
}: {
  search: string;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onSearchChange: (value: string) => void;
  headerActions: ReactNode;
  activeId?: string;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  archivedChats: ChatItem[];
  onLoadMore?: () => void;
  onAddSubagent?: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onOpenInNewWindow?: (id: string) => void;
  /** Opens a nested conversation beside its parent (parent id, child id). */
  onOpenInPanel?: (parentId: string, childId: string) => void;
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
  const t = useTranslations("dashboardNav");
  const [isClearing, setIsClearing] = useState(false);
  const [filter, setFilter] = useState<SidebarChatFilter>("all");
  const isArchived = filter === "archived";
  const items = useMemo(
    () =>
      getSidebarChatItems({
        privateChats,
        sharedChats,
        archivedChats,
        filter,
      }).filter((item) =>
        item.title.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [privateChats, sharedChats, archivedChats, filter, search],
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
  const clearTitle = isArchived
    ? t("chats.clearScope.archived")
    : t("chats.clearScope.private");
  const filterLabel =
    filter === "shared"
      ? t("chats.shared")
      : filter === "archived"
        ? t("chats.archived")
        : t("chats.private");

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
      <div className="group/section-label flex shrink-0 items-center gap-1 px-3 py-2">
        <span className="flex-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {t("chats.heading")}
        </span>
        {headerActions}
        {onClear && clearItems.length > 0 ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                className="invisible size-5 pointer-events-none text-destructive opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:visible focus-visible:pointer-events-auto focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:opacity-100 group-hover/section-label:visible group-hover/section-label:pointer-events-auto group-hover/section-label:opacity-100 group-focus-within/section-label:visible group-focus-within/section-label:pointer-events-auto group-focus-within/section-label:opacity-100"
                size="icon-xs"
                title={t("chats.clearAll", { scope: clearTitle })}
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3" />
                <span className="sr-only">
                  {t("chats.clearAll", { scope: clearTitle })}
                </span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {t("chats.clearConfirmTitle", { scope: clearTitle })}
                </DialogTitle>
                <DialogDescription>
                  {t("chats.clearConfirmDescription", {
                    count: clearItems.length,
                    scope: clearTitle,
                  })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {t("common.cancel")}
                  </Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button
                    disabled={isClearing}
                    onClick={() => void handleClear()}
                    type="button"
                    variant="destructive"
                  >
                    {isClearing ? t("chats.clearing") : t("chats.clearAllButton")}
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
            aria-label={t("chats.clearFilter", { filter: filterLabel })}
          >
            {filterLabel}
            <X className="size-3" />
          </Button>
        ) : null}
        <Button
          className="text-muted-foreground"
          variant="ghost"
          size="icon-xs"
          type="button"
          title={t("chats.searchAll")}
          aria-label={t("chats.searchAll")}
          aria-expanded={searchOpen}
          onClick={onToggleSearch}
        >
          <Search className="size-3.5" />
        </Button>
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
              title={t("chats.filter")}
              aria-label={t("chats.filter")}
            >
              <ListFilter className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("chats.filter")}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => {
                if (
                  value === "all" ||
                  value === "shared" ||
                  value === "private" ||
                  value === "archived"
                ) {
                  setFilter(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="all">
                <MessagesSquare className="size-4" />
                {t("chats.all")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="shared">
                <Users className="size-4" />
                {t("chats.shared")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="private">
                <Lock className="size-4" />
                {t("chats.private")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="archived">
                <Archive className="size-4" />
                {t("chats.archived")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {searchOpen && (
        <div className="shrink-0 px-3 pb-2">
          <SidebarInput
            autoFocus
            aria-label={t("chats.searchAll")}
            className="h-8 text-xs"
            placeholder={t("chats.searchPlaceholder")}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      )}
      <SidebarContent key={filter} className="min-h-0 overflow-y-auto">
        <SidebarGroup className="px-0 pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1 py-0.5">
              {items.map((item) => (
                <Fragment key={item.id}>
                  <ChatListRow
                    active={item.id === activeId}
                    canArchive={!isArchived}
                    item={item}
                    onAddSubagent={isArchived ? undefined : onAddSubagent}
                    onArchive={onArchive}
                    onDelete={onDelete}
                    onOpenInNewWindow={onOpenInNewWindow}
                    onSetVisibility={isArchived ? undefined : onSetVisibility}
                    onOpen={onOpen}
                    onPrefetch={onPrefetch}
                  />
                  {/* One visible level: a chat's sub-agent conversations follow it. */}
                  {item.children?.map((child) => (
                    <ChatListRow
                      key={child.id}
                      active={child.id === activeId}
                      canArchive={!isArchived}
                      item={child}
                      nested
                      onArchive={onArchive}
                      onDelete={onDelete}
                      onOpenInNewWindow={onOpenInNewWindow}
                      onOpenInPanel={onOpenInPanel}
                      onSetVisibility={isArchived ? undefined : onSetVisibility}
                      onOpen={onOpen}
                      onPrefetch={onPrefetch}
                    />
                  ))}
                </Fragment>
              ))}
            </SidebarMenu>
            {items.length === 0 ? (
              <p
                className="px-3 py-4 text-xs text-muted-foreground"
                role="status"
              >
                {isLoadingMore && !isArchived
                  ? t("chats.loadingChats")
                  : canLoadMore
                    ? t("chats.noMatching")
                    : filter !== "all"
                      ? t(`chats.filterEmpty.${filter}`)
                      : t("chats.noneYet")}
              </p>
            ) : null}
            {canLoadMore && onLoadMore ? (
              <div className="px-3 py-1.5">
                <Button
                  className="h-auto w-full justify-center px-0 py-1 text-[11px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
                  disabled={isLoadingMore}
                  onClick={onLoadMore}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {isLoadingMore ? t("chats.loading") : t("chats.loadMore")}
                </Button>
              </div>
            ) : null}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}

export function DashboardSidebarChatPanel({
  brand,
  desktopTitlebar = false,
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
  onCreateAgentChat,
  onCreateChat,
  onDeleteChat,
  onSetChatVisibility,
  onLoadMoreChats,
  onOpenMembers,
  onOpenChat,
  onOpenChatInNewWindow,
  onOpenChatInPanel,
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
  brand?: ReactNode;
  heading: ReactNode;
  desktopTitlebar?: boolean;
  navigation: ReactNode;
  footer: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  archivedChats: ChatItem[];
  activeChatId: string;
  onArchiveChat: (id: string) => void;
  onClearArchivedChats: () => Promise<void>;
  onClearPrivateChats: () => Promise<void>;
  /** Starts a persona-owned thread, nested under `parentThreadId` when set. */
  onCreateAgentChat: (input: {
    personaId: string;
    parentThreadId: string | null;
  }) => Promise<void>;
  onCreateChat: () => void;
  onDeleteChat: (id: string) => Promise<void>;
  onSetChatVisibility: (
    id: string,
    visibility: "private" | "workspace",
  ) => Promise<void>;
  onLoadMoreChats: () => void;
  onOpenMembers?: () => void;
  onOpenChat: (id: string, title: string) => void;
  onOpenChatInNewWindow: (id: string) => void;
  /** Opens a nested conversation beside its parent (parent id, child id). */
  onOpenChatInPanel: (parentId: string, childId: string) => void;
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
  const t = useTranslations("dashboardNav");
  const [chatListResetKey, setChatListResetKey] = useState(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const [personaPicker, setPersonaPicker] = useState<{
    parentThreadId: string | null;
    parentTitle: string | null;
  } | null>(null);
  const openSubagentPicker = (id: string, title: string) =>
    setPersonaPicker({ parentThreadId: id, parentTitle: title });
  // The manager opens on top of the picker; when it closes, the picker
  // refetches so a freshly authored agent is immediately selectable.
  const [personaManagerOpen, setPersonaManagerOpen] = useState(false);
  const [personaRefreshToken, setPersonaRefreshToken] = useState(0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader className="shrink-0 gap-0 px-3 pb-0 pt-0">
        {brand}
        {/* The PC client hides the brand, so the strip above the workspace
            switcher reserves only what the traffic lights occupy, and drags
            the window instead of sitting there empty. */}
        {desktopTitlebar ? (
          <div
            aria-hidden="true"
            data-desktop-drag-region=""
            className="h-10 shrink-0 select-none"
          />
        ) : null}
        <div className={cn("flex min-w-0 items-center gap-1", "h-12 sm:h-14")}>
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
            className="h-9 flex-1 justify-start gap-2 rounded-lg px-3 text-sm font-medium"
            variant="ghost"
            onClick={() => {
              setChatListResetKey((value) => value + 1);
              onCreateChat();
            }}
            size="xs"
            type="button"
          >
            <PenSquare className="size-4 text-muted-foreground" />
            {t("sidebar.newChat")}
          </Button>
        </div>
      </SidebarHeader>
      {navigation}
      <ChatList
        key={`${workspaceId}-${chatListResetKey}`}
        search={search}
        searchOpen={searchOpen || Boolean(search)}
        onToggleSearch={() => {
          setSearchOpen((value) => !value);
          onSearchChange("");
        }}
        onSearchChange={onSearchChange}
        headerActions={
          <>
            <Button
              onClick={() =>
                setPersonaPicker({ parentThreadId: null, parentTitle: null })
              }
              size="icon-xs"
              title={t("sidebar.newAgentChat")}
              type="button"
              variant="ghost"
            >
              <Bot className="size-3" />
              <span className="sr-only">{t("sidebar.newAgentChat")}</span>
            </Button>
            <Button
              onClick={onOpenMembers}
              size="icon-xs"
              title={t("sidebar.inviteManageMembers")}
              type="button"
              variant="ghost"
            >
              <Share2 className="size-3" />
              <span className="sr-only">
                {t("sidebar.inviteManageMembers")}
              </span>
            </Button>
          </>
        }
        activeId={activeChatId}
        hasMore={hasMorePrivateChats}
        isLoadingMore={isLoadingPrivateChats}
        privateChats={privateChats}
        sharedChats={sharedChats}
        archivedChats={archivedChats}
        onLoadMore={onLoadMoreChats}
        onAddSubagent={openSubagentPicker}
        onArchive={onArchiveChat}
        onOpenInNewWindow={onOpenChatInNewWindow}
        onOpenInPanel={onOpenChatInPanel}
        onClearPrivate={onClearPrivateChats}
        onClearArchived={onClearArchivedChats}
        onDelete={onDeleteChat}
        onSetVisibility={onSetChatVisibility}
        onOpen={onOpenChat}
        onPrefetch={onPrefetchChat}
      />

      <PersonaPickerDialog
        onManage={() => setPersonaManagerOpen(true)}
        onOpenChange={(open) => {
          if (!open) setPersonaPicker(null);
        }}
        onPick={(personaId) =>
          onCreateAgentChat({
            personaId,
            parentThreadId: personaPicker?.parentThreadId ?? null,
          })
        }
        open={personaPicker !== null}
        parentTitle={personaPicker?.parentTitle ?? null}
        refreshToken={personaRefreshToken}
        workspaceId={workspaceId}
      />
      <DashboardPersonaManager
        onChanged={() => setPersonaRefreshToken((value) => value + 1)}
        onOpenChange={setPersonaManagerOpen}
        open={personaManagerOpen}
        workspaceId={workspaceId}
      />

      {footer}
    </div>
  );
}

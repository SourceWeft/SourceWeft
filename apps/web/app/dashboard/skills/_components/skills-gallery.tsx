"use client";

import * as React from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  ListFilter,
  Loader2,
  PanelsTopLeft,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";

type SkillCatalogItem = Awaited<
  ReturnType<typeof contentClient.listSkillsCatalog>
>["items"][number];

type ResolvedWorkspace = {
  id: string;
  name: string;
};

type CategoryKey = "all" | "learn" | "research" | "write" | "review" | "operate";
type StatusFilter = "all" | "installed" | "not_installed";
type PublisherFilter = "all" | "official" | "not_official";
type SortKey = "recommended" | "name_asc" | "installed_first" | "official_first";

const categories: Array<{ key: CategoryKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "learn", label: "Learn" },
  { key: "research", label: "Research" },
  { key: "write", label: "Write" },
  { key: "review", label: "Review" },
  { key: "operate", label: "Operate" },
];

const publisherOptions: Array<{ key: PublisherFilter; label: string }> = [
  { key: "all", label: "All publishers" },
  { key: "official", label: "Official" },
  { key: "not_official", label: "Not official" },
];

const statusOptions: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "installed", label: "Installed" },
  { key: "not_installed", label: "Not installed" },
];

const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: "recommended", label: "Recommended" },
  { key: "name_asc", label: "Name A-Z" },
  { key: "installed_first", label: "Installed first" },
  { key: "official_first", label: "Official first" },
];

function publisherLabel(sourceType: SkillCatalogItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  return "Workspace";
}

function iconForSkill(item: SkillCatalogItem) {
  return item.sourceType === "builtin" ? Sparkles : Database;
}

function categoryForSkill(item: SkillCatalogItem): CategoryKey {
  const category = item.categories.find((entry): entry is CategoryKey =>
    categories.some((candidate) => candidate.key === entry),
  );
  if (category) return category;

  const text = `${item.name} ${item.displayName} ${item.description}`.toLowerCase();
  if (text.includes("review") || text.includes("legal") || text.includes("proposal")) return "review";
  if (text.includes("summary") || text.includes("meeting") || text.includes("action")) return "operate";
  if (text.includes("research") || text.includes("source") || text.includes("evidence")) return "research";
  if (text.includes("write") || text.includes("draft")) return "write";
  return "learn";
}

function skillSlug(item: SkillCatalogItem) {
  return item.slug;
}

function skillHref(item: SkillCatalogItem) {
  return `/dashboard/skills/${encodeURIComponent(skillSlug(item))}`;
}

function SortMenu<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const activeLabel = options.find((option) => option.key === value)?.label ?? "Recommended";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
          type="button"
        >
          <span>Sort by</span>
          <span>{activeLabel}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {options.map((option) => (
          <DropdownMenuItem
            className="justify-between"
            key={option.key}
            onClick={() => onChange(option.key)}
          >
            {option.label}
            {option.key === value ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceMenu({
  disabled,
  onChange,
  workspaceId,
  workspaceName,
  workspaces,
}: {
  disabled?: boolean;
  onChange: (workspaceId: string, workspaceName: string) => void;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: Array<{ id: string; name: string }>;
}) {
  const options =
    workspaceId &&
    workspaceName &&
    !workspaces.some((item) => item.id === workspaceId)
      ? [{ id: workspaceId, name: workspaceName }, ...workspaces]
      : workspaces;
  const activeWorkspace =
    options.find((item) => item.id === workspaceId) ??
    (workspaceId && workspaceName
      ? { id: workspaceId, name: workspaceName }
      : null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 max-w-[280px] min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-expanded:bg-accent"
          disabled={disabled || options.length === 0}
          type="button"
        >
          <PanelsTopLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {activeWorkspace?.name ?? "Select workspace"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {options.length === 0 ? (
          <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
        ) : (
          options.map((item, index) => {
            const active = item.id === workspaceId;
            return (
              <DropdownMenuItem
                className="gap-2"
                key={item.id}
                onClick={() => onChange(item.id, item.name)}
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {active ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    `⌘${index + 1}`
                  )}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspacePill({
  workspaceName,
}: {
  workspaceName: string | null | undefined;
}) {
  return (
    <div className="flex h-8 max-w-[280px] min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-foreground">
      <PanelsTopLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {workspaceName || "Current workspace"}
      </span>
    </div>
  );
}

function SkillAvatar({ item }: { item: SkillCatalogItem }) {
  const Icon = iconForSkill(item);
  const palette =
    item.sourceType === "builtin"
      ? "from-sky-500/90 via-cyan-500/80 to-emerald-500/85"
      : "from-violet-500/90 via-fuchsia-500/80 to-rose-500/80";

  return (
    <span
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-linear-to-br text-white shadow-sm",
        palette,
      )}
    >
      <span className="absolute inset-0 bg-black/10" />
      <Icon className="relative h-4.5 w-4.5 drop-shadow" />
    </span>
  );
}

function FilterFacet({
  children,
  defaultOpen = false,
  label,
  summary,
}: {
  children?: React.ReactNode;
  defaultOpen?: boolean;
  label: string;
  summary?: string;
}) {
  return (
    <details className="group border-b border-border" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 hover:bg-accent/40">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{label}</div>
          {summary ? <div className="truncate text-[11px] text-muted-foreground">{summary}</div> : null}
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      {children ? <div className="space-y-1.5 px-3 pb-2">{children}</div> : null}
    </details>
  );
}

function FacetChoice({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent/60",
        active && "bg-accent/60 text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-border text-[10px]",
          active && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {active ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === "number" ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function SkillsFilterPanel({
  category,
  categoryCounts,
  installedCount,
  onCategoryChange,
  onClear,
  onQueryChange,
  onPublisherFilterChange,
  onStatusFilterChange,
  query,
  publisherFilter,
  statusFilter,
  totalCount,
  placement = "desktop",
}: {
  category: CategoryKey;
  categoryCounts: Record<CategoryKey, number>;
  installedCount: number;
  onCategoryChange: (value: CategoryKey) => void;
  onClear: () => void;
  onQueryChange: (value: string) => void;
  onPublisherFilterChange: (value: PublisherFilter) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  query: string;
  publisherFilter: PublisherFilter;
  statusFilter: StatusFilter;
  totalCount: number;
  placement?: "desktop" | "drawer";
}) {
  const notInstalledCount = Math.max(totalCount - installedCount, 0);
  const categorySummary = categories.find((item) => item.key === category)?.label ?? "All";
  const publisherSummary = publisherOptions.find((item) => item.key === publisherFilter)?.label ?? "All publishers";
  const statusSummary = statusOptions.find((item) => item.key === statusFilter)?.label ?? "All";

  return (
    <aside
      className={cn(
        "min-h-0 w-[260px] shrink-0 overflow-hidden border-r border-border bg-card",
        placement === "desktop"
          ? "hidden md:flex md:flex-col"
          : "flex h-full w-full flex-col",
      )}
    >
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={onClear} type="button">
            Clear all
          </button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <FilterFacet defaultOpen label="Search" summary={query.trim() ? query.trim() : "all"}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-7 pl-8 text-xs"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search skills"
              value={query}
            />
          </div>
        </FilterFacet>

        <FilterFacet defaultOpen label="Category" summary={categorySummary}>
          <div className="space-y-1">
            {categories.map((item) => (
              <FacetChoice
                active={category === item.key}
                count={categoryCounts[item.key] ?? 0}
                key={item.key}
                label={item.label}
                onClick={() => onCategoryChange(item.key)}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet label="Publisher" summary={publisherSummary}>
          <div className="space-y-1">
            {publisherOptions.map((item) => (
              <FacetChoice
                active={publisherFilter === item.key}
                key={item.key}
                label={item.label}
                onClick={() => onPublisherFilterChange(item.key)}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet label="Status" summary={statusSummary}>
          <div className="space-y-1">
            {statusOptions.map((item) => (
              <FacetChoice
                active={statusFilter === item.key}
                count={
                  item.key === "installed"
                    ? installedCount
                    : item.key === "not_installed"
                      ? notInstalledCount
                      : totalCount
                }
                key={item.key}
                label={item.label}
                onClick={() => onStatusFilterChange(item.key)}
              />
            ))}
          </div>
        </FilterFacet>
      </ScrollArea>
    </aside>
  );
}

function SkillCard({
  item,
  pending,
  onInstall,
  onUninstall,
  variant = "page",
}: {
  item: SkillCatalogItem;
  pending: boolean;
  onInstall: (item: SkillCatalogItem) => void;
  onUninstall: (item: SkillCatalogItem) => void;
  variant?: "page" | "modal";
}) {
  const href = skillHref(item);
  const compact = variant === "modal";

  return (
    <article
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-4 pb-4 pt-4 shadow-xs transition-colors hover:border-border/90 hover:bg-accent/20",
        compact ? "min-h-[190px]" : "min-h-[202px]",
      )}
    >
      <Link className="flex min-h-0 flex-1 flex-col" href={href}>
        <div className="flex min-w-0 items-center gap-3">
          <SkillAvatar item={item} />
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-6 text-foreground">
            {item.displayName}
          </h3>
          {item.enabled ? (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              <Check className="h-3 w-3" />
              Installed
            </span>
          ) : null}
        </div>

        <p className="mt-3 line-clamp-3 min-h-[60px] text-xs leading-5 text-muted-foreground">
          {item.description}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
            {publisherLabel(item.sourceType)}
          </Badge>
          <Badge className="h-5 px-1.5 text-[10px] capitalize" variant="outline">
            {categoryForSkill(item)}
          </Badge>
        </div>
      </Link>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
        <Button
          asChild
          className="min-w-0 rounded-full px-2"
          size="xs"
          type="button"
          variant="outline"
        >
          <Link href={href}>
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">Details</span>
          </Link>
        </Button>
        <Button
          className="min-w-0 rounded-full px-2"
          disabled={pending}
          onClick={() => (item.enabled ? onUninstall(item) : onInstall(item))}
          size="xs"
          type="button"
          variant={item.enabled ? "secondary" : "default"}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : item.enabled ? (
            <Trash2 className="h-3.5 w-3.5" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span className="min-w-0 truncate">
            {item.enabled ? "Uninstall" : "Install"}
          </span>
        </Button>
      </div>
    </article>
  );
}

export function SkillsGallery({
  className,
  lockWorkspace = false,
  onCatalogChange,
  variant = "page",
  workspaceId,
  workspaceName,
}: {
  className?: string;
  lockWorkspace?: boolean;
  onCatalogChange?: () => void | Promise<void>;
  variant?: "page" | "modal";
  workspaceId?: string | null;
  workspaceName?: string | null;
}) {
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(null);
  const [items, setItems] = React.useState<SkillCatalogItem[]>([]);
  const [pendingCatalogId, setPendingCatalogId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<CategoryKey>("all");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [publisherFilter, setPublisherFilter] = React.useState<PublisherFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("recommended");
  const [isResolvingWorkspace, setIsResolvingWorkspace] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [filtersDrawerOpen, setFiltersDrawerOpen] = React.useState(false);
  const workspaceIdRef = React.useRef<string | null>(null);
  const catalogGenerationRef = React.useRef(0);

  React.useEffect(() => {
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace?.id]);

  const resolveWorkspace = React.useCallback(async () => {
    if (lockWorkspace) {
      const lockedId = workspaceId ?? dashboardState.workspaceId;
      if (!lockedId) {
        return null;
      }
      return {
        id: lockedId,
        name: workspaceName ?? dashboardState.workspaceName,
      };
    }

    if (workspaceId) {
      return {
        id: workspaceId,
        name: workspaceName ?? dashboardState.workspaceName,
      };
    }

    if (dashboardState.workspaceId) {
      return {
        id: dashboardState.workspaceId,
        name: dashboardState.workspaceName,
      };
    }

    const current = await workspaceClient.getCurrentContext();
    if (current.activeWorkspace) {
      return {
        id: current.activeWorkspace.id,
        name: current.activeWorkspace.name,
      };
    }
    return null;
  }, [
    dashboardState.workspaceId,
    dashboardState.workspaceName,
    lockWorkspace,
    workspaceId,
    workspaceName,
  ]);

  const loadCatalog = React.useCallback(async () => {
    const generation = ++catalogGenerationRef.current;
    setError(null);
    setIsResolvingWorkspace(true);
    try {
      const resolved = await resolveWorkspace();
      if (catalogGenerationRef.current !== generation) {
        return;
      }
      setWorkspace(resolved);
      if (!resolved) {
        setItems([]);
        return;
      }

      setIsLoading(true);
      const result = await contentClient.listSkillsCatalog(resolved.id);
      if (catalogGenerationRef.current !== generation) {
        return;
      }
      setItems(result.items);
    } catch (loadError) {
      if (catalogGenerationRef.current !== generation) {
        return;
      }
      setItems([]);
      setError(loadError instanceof Error ? loadError.message : "Failed to load skills.");
    } finally {
      if (catalogGenerationRef.current === generation) {
        setIsResolvingWorkspace(false);
        setIsLoading(false);
      }
    }
  }, [resolveWorkspace]);

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const installedCount = React.useMemo(
    () => items.filter((item) => item.enabled).length,
    [items],
  );

  const categoryCounts = React.useMemo(() => {
    const counts = categories.reduce(
      (record, item) => ({ ...record, [item.key]: 0 }),
      {} as Record<CategoryKey, number>,
    );
    counts.all = items.length;
    for (const item of items) {
      counts[categoryForSkill(item)] += 1;
    }
    return counts;
  }, [items]);

  const filteredItems = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (category !== "all" && categoryForSkill(item) !== category) return false;
      if (statusFilter === "installed" && !item.enabled) return false;
      if (statusFilter === "not_installed" && item.enabled) return false;
      if (publisherFilter === "official" && item.sourceType !== "builtin") return false;
      if (publisherFilter === "not_official" && item.sourceType === "builtin") return false;
      if (!q) return true;
      return (
        item.displayName.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });

    return filtered.sort((a, b) => {
      if (sort === "name_asc") return a.displayName.localeCompare(b.displayName);
      if (sort === "installed_first") return Number(b.enabled) - Number(a.enabled);
      if (sort === "official_first") return Number(b.sourceType === "builtin") - Number(a.sourceType === "builtin");
      return 0;
    });
  }, [category, items, publisherFilter, query, sort, statusFilter]);

  const clearFilters = React.useCallback(() => {
    setQuery("");
    setCategory("all");
    setStatusFilter("all");
    setPublisherFilter("all");
  }, []);

  const handleWorkspaceChange = React.useCallback(
    async (nextWorkspaceId: string, nextWorkspaceName: string) => {
      if (lockWorkspace || nextWorkspaceId === workspace?.id) {
        return;
      }

      setWorkspace({ id: nextWorkspaceId, name: nextWorkspaceName });
      setItems([]);
      setError(null);
      setIsLoading(true);
      try {
        await dashboardState.switchWorkspace(nextWorkspaceId, nextWorkspaceName);
        if (workspaceIdRef.current !== nextWorkspaceId) {
          return;
        }
        const result = await contentClient.listSkillsCatalog(nextWorkspaceId);
        if (workspaceIdRef.current !== nextWorkspaceId) {
          return;
        }
        setItems(result.items);
      } catch (changeError) {
        setItems([]);
        setError(
          changeError instanceof Error
            ? changeError.message
            : "Failed to switch workspace.",
        );
      } finally {
        setIsLoading(false);
        setIsResolvingWorkspace(false);
      }
    },
    [dashboardState, lockWorkspace, workspace?.id],
  );

  async function installSkill(item: SkillCatalogItem) {
    if (!workspace || item.enabled) return;

    const activeWorkspaceId = workspace.id;
    setPendingCatalogId(item.catalogId);
    try {
      const result = await contentClient.enableWorkspaceSkill(activeWorkspaceId, {
        skillId: item.skillId,
        skillVersionId: item.skillVersionId,
      });
      if (workspaceIdRef.current === activeWorkspaceId) {
        setItems((currentItems) =>
          currentItems.map((candidate) =>
            candidate.catalogId === item.catalogId
              ? {
                  ...candidate,
                  enabled: result.workspaceSkill.enabled,
                  enabledWorkspaceSkillId: result.workspaceSkill.id,
                }
              : candidate,
          ),
        );
      }
      toast.success("Skill installed");
      await onCatalogChange?.();
    } catch (installError) {
      toast.error(installError instanceof Error ? installError.message : "Failed to install skill.");
    } finally {
      setPendingCatalogId(null);
    }
  }

  async function uninstallSkill(item: SkillCatalogItem) {
    if (!workspace || !item.enabled) return;
    if (!item.enabledWorkspaceSkillId) {
      toast.error("Skill install record is missing. Refresh and try again.");
      return;
    }

    const activeWorkspaceId = workspace.id;
    const workspaceSkillId = item.enabledWorkspaceSkillId;
    setPendingCatalogId(item.catalogId);
    try {
      await contentClient.deleteWorkspaceSkill(activeWorkspaceId, workspaceSkillId);
      if (workspaceIdRef.current === activeWorkspaceId) {
        setItems((currentItems) =>
          currentItems.map((candidate) =>
            candidate.catalogId === item.catalogId
              ? {
                  ...candidate,
                  enabled: false,
                  enabledWorkspaceSkillId: null,
                }
              : candidate,
          ),
        );
      }
      toast.success("Skill uninstalled");
      await onCatalogChange?.();
    } catch (uninstallError) {
      toast.error(uninstallError instanceof Error ? uninstallError.message : "Failed to uninstall skill.");
    } finally {
      setPendingCatalogId(null);
    }
  }

  const pageLoading = isResolvingWorkspace || (isLoading && items.length === 0);
  const currentWorkspaceName =
    workspace?.name ?? workspaceName ?? dashboardState.workspaceName;
  const filtersPanel = (
    <SkillsFilterPanel
      category={category}
      categoryCounts={categoryCounts}
      installedCount={installedCount}
      onCategoryChange={setCategory}
      onClear={clearFilters}
      onQueryChange={setQuery}
      onPublisherFilterChange={setPublisherFilter}
      onStatusFilterChange={setStatusFilter}
      query={query}
      publisherFilter={publisherFilter}
      statusFilter={statusFilter}
      totalCount={items.length}
    />
  );
  const drawerFiltersPanel = (
    <SkillsFilterPanel
      category={category}
      categoryCounts={categoryCounts}
      installedCount={installedCount}
      onCategoryChange={setCategory}
      onClear={clearFilters}
      onQueryChange={setQuery}
      onPublisherFilterChange={setPublisherFilter}
      onStatusFilterChange={setStatusFilter}
      placement="drawer"
      query={query}
      publisherFilter={publisherFilter}
      statusFilter={statusFilter}
      totalCount={items.length}
    />
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-background", className)}>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {filtersPanel}

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-4 py-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    className="h-8 gap-1.5 px-2 text-xs md:hidden"
                    onClick={() => setFiltersDrawerOpen(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <ListFilter className="h-4 w-4" />
                    Filters
                  </Button>
                  {lockWorkspace ? (
                    <WorkspacePill workspaceName={currentWorkspaceName} />
                  ) : (
                    <WorkspaceMenu
                      disabled={isResolvingWorkspace}
                      onChange={(nextWorkspaceId, nextWorkspaceName) =>
                        void handleWorkspaceChange(nextWorkspaceId, nextWorkspaceName)
                      }
                      workspaceId={workspace?.id ?? dashboardState.workspaceId}
                      workspaceName={workspace?.name ?? dashboardState.workspaceName}
                      workspaces={dashboardState.workspaces}
                    />
                  )}
                </div>
                <SortMenu
                  onChange={setSort}
                  options={sortOptions}
                  value={sort}
                />
              </div>
              {error ? (
                <p className="mb-4 text-xs text-red-600 dark:text-red-300">{error}</p>
              ) : null}

              {pageLoading ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading skills...
                </div>
              ) : error ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-5 text-sm text-destructive">
                  <p className="font-medium">Skills could not be loaded</p>
                  <p className="mt-1 text-destructive/85">{error}</p>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  {items.length === 0
                    ? "No skills are available for this workspace."
                    : "No skills match the current filters."}
                </div>
              ) : (
                <div
                  className={cn(
                    "grid gap-4",
                    variant === "modal"
                      ? "grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]"
                      : "grid-cols-[repeat(auto-fill,minmax(260px,1fr))] 2xl:grid-cols-4",
                  )}
                >
                  {filteredItems.map((item) => (
                    <SkillCard
                      item={item}
                      key={item.catalogId}
                      onInstall={(next) => void installSkill(next)}
                      onUninstall={(next) => void uninstallSkill(next)}
                      pending={pendingCatalogId === item.catalogId}
                      variant={variant}
                    />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </section>
      </div>
      <Sheet open={filtersDrawerOpen} onOpenChange={setFiltersDrawerOpen}>
        <SheetContent
          className="w-[min(100vw,320px)] max-w-none gap-0 overflow-hidden p-0 [&>button]:hidden"
          side="left"
        >
          <SheetTitle className="sr-only">Skill filters</SheetTitle>
          {drawerFiltersPanel}
        </SheetContent>
      </Sheet>
    </div>
  );
}

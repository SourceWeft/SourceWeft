"use client";

import { SkillAvatar } from "./skill-avatar";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  ListFilter,
  Loader2,
  PanelsTopLeft,
  Scale,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { SkillCatalogCategory } from "@sourceweft/contracts";
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
import { SkillIcon } from "../../../_components/site-icons";
import { SkillDetailDialog } from "./skill-detail-dialog";
import { MySubmissions, useSkillSubmissions } from "./skill-submissions";
import {
  defaultSkillsBrowseState,
  excludesBoundedSkills,
  firstSkillCategoryName,
  formatInstallCount,
  hasActiveSkillFilters,
  isInvalidCursorError,
  mergeSkillPages,
  parseSkillsBrowseState,
  partitionSkills,
  skillCapabilityValues,
  skillInstalledValues,
  skillsBrowseSearch,
  skillsCatalogRequest,
  skillSortValues,
  skillTrustValues,
  SKILLS_QUERY_MAX_LENGTH,
  visibleSkillCategories,
  type SkillsBrowseState,
} from "./skills-market-browse";
import { skillsMarketCopy } from "./skills-market-copy";
import { SubmitSkillDialog } from "./submit-skill-dialog";

type SkillsCatalogResponse = Awaited<
  ReturnType<typeof contentClient.listSkillsCatalog>
>;
type SkillCatalogItem = SkillsCatalogResponse["items"][number];

type ResolvedWorkspace = {
  id: string;
  name: string;
};

type CatalogStatus =
  "resolving_workspace" | "loading_catalog" | "ready" | "error";

const copy = skillsMarketCopy;
const QUERY_DEBOUNCE_MS = 300;

const trustOptions = skillTrustValues.map((key) => ({
  key,
  label: copy.trustOptions[key],
}));
const capabilityOptions = skillCapabilityValues.map((key) => ({
  key,
  label: copy.capabilityOptions[key],
}));
const installedOptions = skillInstalledValues.map((key) => ({
  key,
  label: copy.installedOptions[key],
}));
const sortOptions = skillSortValues.map((key) => ({
  key,
  label: copy.sortOptions[key],
}));

function publisherLabel(sourceType: SkillCatalogItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  if (sourceType === "registry_github") return "Community";
  return "Workspace";
}

function isUnverifiedRegistrySkill(item: SkillCatalogItem) {
  return item.sourceType === "registry_github" && !item.verified;
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
  const activeLabel =
    options.find((option) => option.key === value)?.label ?? "Recommended";

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
                  {active ? <Check className="h-3.5 w-3.5" /> : `⌘${index + 1}`}
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

function SkillSkeletonBlock({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted/80", className)} />
  );
}

function SkillSkeletonLine({ className }: { className?: string }) {
  return <SkillSkeletonBlock className={cn("h-3", className)} />;
}

function SkillsCatalogSkeletonGrid({
  variant = "page",
}: {
  variant?: "page" | "modal";
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        variant === "modal"
          ? "grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(260px,1fr))] 2xl:grid-cols-4",
      )}
    >
      {Array.from({ length: variant === "modal" ? 6 : 9 }).map((_, index) => (
        <article
          className={cn(
            "flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-4 pb-4 pt-4 shadow-xs",
            variant === "modal" ? "min-h-[190px]" : "min-h-[202px]",
          )}
          key={index}
        >
          <div className="flex min-w-0 items-center gap-3">
            <SkillSkeletonBlock className="size-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkillSkeletonLine className="w-36" />
              <SkillSkeletonLine className="w-20" />
            </div>
            <SkillSkeletonBlock className="h-5 w-16 rounded-full" />
          </div>
          <div className="mt-3 space-y-2">
            <SkillSkeletonLine className="w-full" />
            <SkillSkeletonLine className="w-11/12" />
            <SkillSkeletonLine className="w-3/4" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <SkillSkeletonBlock className="h-5 w-16 rounded-full" />
            <SkillSkeletonBlock className="h-5 w-20 rounded-full" />
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3">
            <SkillSkeletonBlock className="h-7 rounded-full" />
            <SkillSkeletonBlock className="h-7 rounded-full" />
          </div>
        </article>
      ))}
    </div>
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
          <div className="truncate text-xs font-medium text-foreground">
            {label}
          </div>
          {summary ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {summary}
            </div>
          ) : null}
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      {children ? (
        <div className="space-y-1.5 px-3 pb-2">{children}</div>
      ) : null}
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
  categories,
  onChange,
  onClear,
  onQueryInputChange,
  queryInput,
  state,
  placement = "desktop",
}: {
  categories: SkillCatalogCategory[];
  onChange: (patch: Partial<SkillsBrowseState>) => void;
  onClear: () => void;
  onQueryInputChange: (value: string) => void;
  queryInput: string;
  state: SkillsBrowseState;
  placement?: "desktop" | "drawer";
}) {
  const offeredCategories = visibleSkillCategories(categories, state.category);
  const categorySummary =
    state.category === "all"
      ? copy.gallery.categoryAll
      : (categories.find((item) => item.slug === state.category)?.name ??
        state.category);

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
          <h2 className="text-sm font-semibold text-foreground">
            {copy.gallery.filtersTitle}
          </h2>
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onClear}
            type="button"
          >
            {copy.gallery.clearAll}
          </button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <FilterFacet
          defaultOpen
          label={copy.gallery.searchLabel}
          summary={queryInput.trim() || copy.gallery.searchSummaryAll}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-7 pl-8 text-xs"
              maxLength={SKILLS_QUERY_MAX_LENGTH}
              onChange={(event) => onQueryInputChange(event.target.value)}
              placeholder={copy.gallery.searchPlaceholder}
              value={queryInput}
            />
          </div>
        </FilterFacet>

        <FilterFacet
          defaultOpen
          label={copy.gallery.categoryLabel}
          summary={categorySummary}
        >
          <div className="space-y-1">
            <FacetChoice
              active={state.category === "all"}
              label={copy.gallery.categoryAll}
              onClick={() => onChange({ category: "all" })}
            />
            {offeredCategories.map((item) => (
              <FacetChoice
                active={state.category === item.slug}
                count={item.count}
                key={item.slug}
                label={item.name}
                onClick={() =>
                  onChange({
                    category: state.category === item.slug ? "all" : item.slug,
                  })
                }
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet
          label={copy.gallery.trustLabel}
          summary={copy.trustOptions[state.trust]}
        >
          <div className="space-y-1">
            {trustOptions.map((item) => (
              <FacetChoice
                active={state.trust === item.key}
                key={item.key}
                label={item.label}
                onClick={() => onChange({ trust: item.key })}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet
          label={copy.gallery.capabilityLabel}
          summary={copy.capabilityOptions[state.capability]}
        >
          <div className="space-y-1">
            {capabilityOptions.map((item) => (
              <FacetChoice
                active={state.capability === item.key}
                key={item.key}
                label={item.label}
                onClick={() => onChange({ capability: item.key })}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet
          label={copy.gallery.installedLabel}
          summary={copy.installedOptions[state.installed]}
        >
          <div className="space-y-1">
            {installedOptions.map((item) => (
              <FacetChoice
                active={state.installed === item.key}
                key={item.key}
                label={item.label}
                onClick={() => onChange({ installed: item.key })}
              />
            ))}
          </div>
        </FilterFacet>
      </ScrollArea>
    </aside>
  );
}

function SkillCard({
  categories,
  item,
  onOpenDetails,
  pending,
  onInstall,
  onUninstall,
  variant = "page",
}: {
  categories: SkillCatalogCategory[];
  item: SkillCatalogItem;
  onOpenDetails: (item: SkillCatalogItem) => void;
  pending: boolean;
  onInstall: (item: SkillCatalogItem) => void;
  onUninstall: (item: SkillCatalogItem) => void;
  variant?: "page" | "modal";
}) {
  const compact = variant === "modal";
  const installed =
    item.sourceType === "registry_github"
      ? !!item.enabledWorkspaceSkillId
      : item.enabled;
  const canManageInstall =
    item.installable !== false ||
    (item.sourceType === "registry_github" && installed);
  const isRegistry = item.sourceType === "registry_github";
  const unverified = isUnverifiedRegistrySkill(item);
  const categoryName = firstSkillCategoryName(item, categories);
  const installCount = formatInstallCount(item.installCount);
  const installCountLabel =
    item.installCount === 1
      ? copy.card.installsOne
      : installCount
        ? copy.card.installs(installCount)
        : null;

  return (
    <article
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-4 pb-4 pt-4 shadow-xs transition-colors hover:border-border/90 hover:bg-accent/20",
        compact ? "min-h-[190px]" : "min-h-[202px]",
      )}
    >
      <button
        className="flex min-h-0 flex-1 flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenDetails(item)}
        type="button"
      >
        <div className="flex min-w-0 items-center gap-3">
          <SkillAvatar item={item} />
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-6 text-foreground">
            {item.displayName}
          </h3>
          {canManageInstall ? (
            installed ? (
              <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                <Check className="h-3 w-3" />
                Installed
              </span>
            ) : null
          ) : (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {isRegistry ? "Unavailable" : "Built-in"}
            </span>
          )}
        </div>

        <p className="mt-3 line-clamp-3 min-h-[60px] text-xs leading-5 text-muted-foreground">
          {item.description}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
            {publisherLabel(item.sourceType)}
          </Badge>
          {isRegistry && item.verified ? (
            <Badge className="h-5 gap-1 px-1.5 text-[10px]" variant="secondary">
              <BadgeCheck className="h-2.5 w-2.5" />
              {copy.card.verified}
            </Badge>
          ) : null}
          {categoryName ? (
            <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
              {categoryName}
            </Badge>
          ) : null}
          {item.flagged ? (
            <Badge
              className="h-5 gap-1 border-amber-500/30 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"
              variant="outline"
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              Under review
            </Badge>
          ) : unverified ? (
            <Badge
              className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
              variant="outline"
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              Unverified
            </Badge>
          ) : null}
          {item.capability === "executable" ? (
            <Badge
              className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
              variant="outline"
            >
              <SquareTerminal className="h-2.5 w-2.5" />
              {copy.card.includesScripts}
            </Badge>
          ) : null}
          {item.license ? (
            <Badge
              className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
              variant="outline"
            >
              <Scale className="h-2.5 w-2.5" />
              {item.license}
            </Badge>
          ) : null}
          {installCount && installCountLabel ? (
            <span
              aria-label={installCountLabel}
              className="inline-flex h-5 items-center gap-1 px-0.5 text-[10px] text-muted-foreground"
              title={installCountLabel}
            >
              <Download className="h-2.5 w-2.5" />
              {installCount}
            </span>
          ) : null}
        </div>
      </button>

      {isRegistry && item.sourceUrl ? (
        <a
          className="mt-2 inline-flex w-fit max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          href={item.sourceUrl}
          onClick={(event) => event.stopPropagation()}
          rel="noreferrer noopener"
          target="_blank"
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">Source</span>
        </a>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
        <Button
          className="min-w-0 rounded-full px-2"
          onClick={() => onOpenDetails(item)}
          size="xs"
          type="button"
          variant="outline"
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">Details</span>
        </Button>
        {canManageInstall ? (
          <Button
            className="min-w-0 rounded-full px-2"
            disabled={pending}
            onClick={() => (installed ? onUninstall(item) : onInstall(item))}
            size="xs"
            type="button"
            variant={installed ? "secondary" : "default"}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : installed ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <SkillIcon className="h-3.5 w-3.5" />
            )}
            <span className="min-w-0 truncate">
              {installed ? "Uninstall" : "Install"}
            </span>
          </Button>
        ) : (
          <Button
            className="min-w-0 rounded-full px-2"
            disabled
            size="xs"
            type="button"
            variant="secondary"
          >
            <Check className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">
              {isRegistry ? "Unavailable" : "Built-in"}
            </span>
          </Button>
        )}
      </div>
    </article>
  );
}

/**
 * Asks for the next page as the reader nears the end of the grid. The probe is
 * a tall invisible strip ending at the grid's bottom edge, so it intersects
 * well before the end is on screen — a `rootMargin` would not help here, since
 * the gallery scrolls inside its own scroll area, not the viewport. `watchKey`
 * re-arms the observer after each page: if the strip is still in view once a
 * page lands, no new intersection event would fire on its own.
 */
function LoadMoreSentinel({
  onVisible,
  watchKey,
}: {
  onVisible: () => void;
  watchKey: string;
}) {
  const probeRef = React.useRef<HTMLDivElement | null>(null);
  const onVisibleRef = React.useRef(onVisible);
  React.useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  React.useEffect(() => {
    const probe = probeRef.current;
    if (!probe || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisibleRef.current();
      }
    });
    observer.observe(probe);
    return () => observer.disconnect();
  }, [watchKey]);

  return (
    <div className="relative h-px w-full">
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-[800px] w-px"
        ref={probeRef}
      />
    </div>
  );
}

type SkillsGalleryProps = {
  className?: string;
  lockWorkspace?: boolean;
  onCatalogChange?: () => void | Promise<void>;
  variant?: "page" | "modal";
  workspaceId?: string | null;
  workspaceName?: string | null;
};

/**
 * On its own page the gallery keeps its filters, sort and search in the URL,
 * so a view can be linked and survives a reload. Inside the chat's modal it
 * must not write to the chat's URL, so the same state lives in memory.
 */
export function SkillsGallery(props: SkillsGalleryProps) {
  return props.variant === "modal" ? (
    <MemoryStateSkillsGallery {...props} />
  ) : (
    <UrlStateSkillsGallery {...props} />
  );
}

function MemoryStateSkillsGallery(props: SkillsGalleryProps) {
  const [browseState, setBrowseState] = React.useState<SkillsBrowseState>(
    defaultSkillsBrowseState,
  );
  return (
    <SkillsGalleryView
      {...props}
      browseState={browseState}
      onBrowseStateChange={setBrowseState}
    />
  );
}

function UrlStateSkillsGallery(props: SkillsGalleryProps) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const browseState = React.useMemo(
    () => parseSkillsBrowseState(new URLSearchParams(search)),
    [search],
  );
  const setBrowseState = React.useCallback(
    (next: SkillsBrowseState) => {
      // Read the live URL, not the render's: two changes can land between
      // renders, and params this gallery does not own must survive.
      const nextSearch = skillsBrowseSearch(
        next,
        new URLSearchParams(window.location.search),
      );
      // Filters replace the entry instead of pushing one — Back should leave
      // the gallery, not replay every keystroke. Next keeps `useSearchParams`
      // in sync with native history calls.
      window.history.replaceState(
        null,
        "",
        nextSearch ? `${pathname}?${nextSearch}` : pathname,
      );
    },
    [pathname],
  );
  return (
    <SkillsGalleryView
      {...props}
      browseState={browseState}
      onBrowseStateChange={setBrowseState}
    />
  );
}

function SkillsGalleryView({
  browseState,
  className,
  lockWorkspace = false,
  onBrowseStateChange,
  onCatalogChange,
  variant = "page",
  workspaceId,
  workspaceName,
}: SkillsGalleryProps & {
  browseState: SkillsBrowseState;
  onBrowseStateChange: (next: SkillsBrowseState) => void;
}) {
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(
    null,
  );
  const [items, setItems] = React.useState<SkillCatalogItem[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  // How many community skills the filters match in all, from the first page.
  const [registryTotal, setRegistryTotal] = React.useState<number | null>(
    null,
  );
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  // Set by a failed page load so the sentinel does not hammer a failing
  // endpoint; the "Load more" button stays as the retry.
  const [loadMoreFailed, setLoadMoreFailed] = React.useState(false);
  const [categories, setCategories] = React.useState<SkillCatalogCategory[]>(
    [],
  );
  const [pendingCatalogId, setPendingCatalogId] = React.useState<string | null>(
    null,
  );
  const [queryInput, setQueryInput] = React.useState(browseState.query);
  const [catalogStatus, setCatalogStatus] = React.useState<CatalogStatus>(
    "resolving_workspace",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [filtersDrawerOpen, setFiltersDrawerOpen] = React.useState(false);
  const [selectedCatalogId, setSelectedCatalogId] = React.useState<
    string | null
  >(null);
  const workspaceIdRef = React.useRef<string | null>(null);
  // Bumped whenever the result set changes identity (workspace, filters, sort,
  // query, reload). A response is applied only if its generation is still the
  // current one, so a slow answer to an old question can never overwrite the
  // answer to the new one.
  const catalogGenerationRef = React.useRef(0);
  const loadingMoreGenerationRef = React.useRef<number | null>(null);
  const committedQueryRef = React.useRef(browseState.query);

  React.useEffect(() => {
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace?.id]);

  const changeBrowseState = React.useCallback(
    (patch: Partial<SkillsBrowseState>) => {
      onBrowseStateChange({ ...browseState, ...patch });
    },
    [browseState, onBrowseStateChange],
  );

  // Search: the input is local and immediate; the query that drives requests
  // (and the URL) follows it after a pause in typing.
  React.useEffect(() => {
    const nextQuery = queryInput.trim().slice(0, SKILLS_QUERY_MAX_LENGTH);
    if (nextQuery === browseState.query) return;
    const handle = window.setTimeout(() => {
      committedQueryRef.current = nextQuery;
      changeBrowseState({ query: nextQuery });
    }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [browseState.query, changeBrowseState, queryInput]);

  // A query that arrived from outside the input (a pasted link, "Clear all")
  // is shown in it. One this input committed is not written back, or it would
  // clobber whatever was typed since.
  React.useEffect(() => {
    if (committedQueryRef.current === browseState.query) return;
    committedQueryRef.current = browseState.query;
    setQueryInput(browseState.query);
  }, [browseState.query]);

  const resolveWorkspace = React.useCallback(async () => {
    if (
      !workspaceId &&
      !dashboardState.workspaceId &&
      !dashboardState.hasWorkspaceHydrated
    ) {
      return undefined;
    }

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
    dashboardState.hasWorkspaceHydrated,
    lockWorkspace,
    workspaceId,
    workspaceName,
  ]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resolved = await resolveWorkspace();
        if (cancelled) return;
        if (resolved === undefined) {
          setCatalogStatus("resolving_workspace");
          return;
        }
        setWorkspace((current) =>
          current?.id === resolved?.id && current?.name === resolved?.name
            ? current
            : resolved,
        );
        if (!resolved) {
          catalogGenerationRef.current += 1;
          setItems([]);
          setNextCursor(null);
          setError(null);
          setCatalogStatus("ready");
        }
      } catch (resolveError) {
        if (cancelled) return;
        setItems([]);
        setNextCursor(null);
        setCatalogStatus("error");
        setError(
          resolveError instanceof Error
            ? resolveError.message
            : copy.gallery.loadFailed,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveWorkspace]);

  // Page one of a result set. `soft` keeps what is on screen until the answer
  // lands (a refresh of the same view); otherwise the grid resets to skeletons.
  const loadFirstPage = React.useCallback(
    async (
      targetWorkspaceId: string,
      state: SkillsBrowseState,
      soft: boolean,
    ) => {
      const generation = ++catalogGenerationRef.current;
      loadingMoreGenerationRef.current = null;
      setIsLoadingMore(false);
      setLoadMoreFailed(false);
      if (!soft) {
        setItems([]);
        setNextCursor(null);
        setRegistryTotal(null);
        setError(null);
        setCatalogStatus("loading_catalog");
      }
      try {
        const page = await contentClient.listSkillsCatalog(
          targetWorkspaceId,
          skillsCatalogRequest(state),
        );
        if (catalogGenerationRef.current !== generation) return;
        setItems(page.items);
        setNextCursor(page.nextCursor ?? null);
        setRegistryTotal(page.registryTotal ?? null);
        setError(null);
        setCatalogStatus("ready");
      } catch (loadError) {
        if (catalogGenerationRef.current !== generation) return;
        // A failed refresh leaves the loaded view in place.
        if (soft) return;
        setItems([]);
        setNextCursor(null);
        setCatalogStatus("error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : copy.gallery.loadFailed,
        );
      }
    },
    [],
  );

  const activeWorkspaceId = workspace?.id ?? null;

  // Any change to workspace, filters, sort or query starts over from page one:
  // a cursor is only good for the exact request that produced it.
  React.useEffect(() => {
    if (!activeWorkspaceId) return;
    void loadFirstPage(activeWorkspaceId, browseState, false);
    return () => {
      catalogGenerationRef.current += 1;
    };
  }, [activeWorkspaceId, browseState, loadFirstPage]);

  const loadCategories = React.useCallback(
    async (targetWorkspaceId: string) => {
      try {
        const result =
          await contentClient.listSkillCatalogCategories(targetWorkspaceId);
        if (workspaceIdRef.current === targetWorkspaceId) {
          setCategories(result.items);
        }
      } catch {
        // The category facet is an aid, not a gate: without it the gallery
        // still lists, searches and sorts.
        if (workspaceIdRef.current === targetWorkspaceId) setCategories([]);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!activeWorkspaceId) {
      setCategories([]);
      return;
    }
    void loadCategories(activeWorkspaceId);
  }, [activeWorkspaceId, loadCategories]);

  const loadMore = React.useCallback(async () => {
    if (!activeWorkspaceId || !nextCursor) return;
    const generation = catalogGenerationRef.current;
    if (loadingMoreGenerationRef.current === generation) return;
    loadingMoreGenerationRef.current = generation;
    setIsLoadingMore(true);
    try {
      const page = await contentClient.listSkillsCatalog(
        activeWorkspaceId,
        skillsCatalogRequest(browseState, nextCursor),
      );
      if (catalogGenerationRef.current !== generation) return;
      setItems((current) => mergeSkillPages(current, page.items));
      // A cursor handed out twice would loop forever; stop with what we have.
      setNextCursor(
        page.nextCursor && page.nextCursor !== nextCursor
          ? page.nextCursor
          : null,
      );
    } catch (loadError) {
      if (catalogGenerationRef.current !== generation) return;
      if (isInvalidCursorError(loadError)) {
        // The server no longer honours this cursor: start the view over.
        void loadFirstPage(activeWorkspaceId, browseState, false);
        return;
      }
      // Stop auto-paging on a failure — the button below remains as a retry.
      setLoadMoreFailed(true);
      toast.error(copy.gallery.loadMoreFailed);
    } finally {
      if (loadingMoreGenerationRef.current === generation) {
        loadingMoreGenerationRef.current = null;
      }
      if (catalogGenerationRef.current === generation) {
        setIsLoadingMore(false);
      }
    }
  }, [activeWorkspaceId, browseState, loadFirstPage, nextCursor]);

  const clearFilters = React.useCallback(() => {
    committedQueryRef.current = "";
    setQueryInput("");
    onBrowseStateChange({
      ...defaultSkillsBrowseState,
      sort: browseState.sort,
    });
  }, [browseState.sort, onBrowseStateChange]);

  const handleWorkspaceChange = React.useCallback(
    async (nextWorkspaceId: string, nextWorkspaceName: string) => {
      if (lockWorkspace || nextWorkspaceId === workspace?.id) {
        return;
      }

      workspaceIdRef.current = nextWorkspaceId;
      setSelectedCatalogId(null);
      setCategories([]);
      setItems([]);
      setNextCursor(null);
      setError(null);
      setCatalogStatus("loading_catalog");
      // The catalog effect loads page one for the new workspace.
      setWorkspace({ id: nextWorkspaceId, name: nextWorkspaceName });
      try {
        await dashboardState.switchWorkspace(
          nextWorkspaceId,
          nextWorkspaceName,
        );
      } catch (changeError) {
        if (workspaceIdRef.current !== nextWorkspaceId) return;
        catalogGenerationRef.current += 1;
        setItems([]);
        setNextCursor(null);
        setCatalogStatus("error");
        setError(
          changeError instanceof Error
            ? changeError.message
            : "Failed to switch workspace.",
        );
      }
    },
    [dashboardState, lockWorkspace, workspace?.id],
  );

  async function installSkill(item: SkillCatalogItem) {
    if (!workspace || item.enabled || item.installable === false) return;

    const activeWorkspaceId = workspace.id;
    setPendingCatalogId(item.catalogId);
    try {
      const result = await contentClient.enableWorkspaceSkill(
        activeWorkspaceId,
        {
          skillId: item.skillId,
          skillVersionId: item.skillVersionId,
        },
      );
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
      toast.error(
        installError instanceof Error
          ? installError.message
          : "Failed to install skill.",
      );
    } finally {
      setPendingCatalogId(null);
    }
  }

  async function uninstallSkill(item: SkillCatalogItem) {
    if (!workspace || !item.enabled) return;
    if (item.sourceType === "builtin" && item.installable === false) return;
    if (!item.enabledWorkspaceSkillId) {
      toast.error("Skill install record is missing. Refresh and try again.");
      return;
    }

    const activeWorkspaceId = workspace.id;
    const workspaceSkillId = item.enabledWorkspaceSkillId;
    setPendingCatalogId(item.catalogId);
    try {
      await contentClient.deleteWorkspaceSkill(
        activeWorkspaceId,
        workspaceSkillId,
      );
      if (workspaceIdRef.current === activeWorkspaceId) {
        setItems((currentItems) =>
          currentItems.map((candidate) =>
            candidate.catalogId === item.catalogId
              ? {
                  ...candidate,
                  enabled: false,
                }
              : candidate,
          ),
        );
      }
      toast.success("Skill uninstalled");
      await onCatalogChange?.();
    } catch (uninstallError) {
      toast.error(
        uninstallError instanceof Error
          ? uninstallError.message
          : "Failed to uninstall skill.",
      );
    } finally {
      setPendingCatalogId(null);
    }
  }

  // Best-effort refresh of the current view (after an import finishes, after a
  // version switch): page one again, in place, plus the category counts.
  const refreshCatalog = React.useCallback(async () => {
    const currentWorkspaceId = workspaceIdRef.current;
    if (!currentWorkspaceId) return;
    await Promise.all([
      loadFirstPage(currentWorkspaceId, browseState, true),
      loadCategories(currentWorkspaceId),
    ]);
    await onCatalogChange?.();
  }, [browseState, loadCategories, loadFirstPage, onCatalogChange]);

  // An import finishes in the background, whenever it finishes; that is when
  // the catalog may have gained skills (even a failed one can have indexed some).
  const submissions = useSkillSubmissions({
    workspaceId: workspace?.id ?? dashboardState.workspaceId,
    onFinished: () => void refreshCatalog(),
  });

  const pageLoading =
    catalogStatus === "resolving_workspace" ||
    catalogStatus === "loading_catalog";
  const currentWorkspaceName =
    workspace?.name ?? workspaceName ?? dashboardState.workspaceName;
  const selectedItem = selectedCatalogId
    ? (items.find((item) => item.catalogId === selectedCatalogId) ?? null)
    : null;
  const filtersActive = hasActiveSkillFilters(browseState);
  // Built-ins and the workspace's own skills arrive whole on page one (unless a
  // filter rules them out); community skills follow, page by page.
  const sections = partitionSkills(items);
  const sectionList = [
    { key: "builtin", label: copy.gallery.sectionBuiltin, items: sections.builtin },
    { key: "yours", label: copy.gallery.sectionYours, items: sections.yours },
    {
      key: "community",
      label: copy.gallery.sectionCommunity,
      items: sections.community,
    },
  ].filter((section) => section.items.length > 0);
  const showSectionHeadings =
    !excludesBoundedSkills(browseState) && sectionList.length > 1;
  const gridClassName = cn(
    "grid gap-4",
    variant === "modal"
      ? "grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]"
      : "grid-cols-[repeat(auto-fill,minmax(260px,1fr))] 2xl:grid-cols-4",
  );
  const renderCard = (item: SkillCatalogItem) => (
    <SkillCard
      categories={categories}
      item={item}
      key={item.catalogId}
      onInstall={(next) => void installSkill(next)}
      onOpenDetails={(next) => setSelectedCatalogId(next.catalogId)}
      onUninstall={(next) => void uninstallSkill(next)}
      pending={pendingCatalogId === item.catalogId}
      variant={variant}
    />
  );
  const filterPanelProps = {
    categories,
    onChange: changeBrowseState,
    onClear: clearFilters,
    onQueryInputChange: setQueryInput,
    queryInput,
    state: browseState,
  };

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SkillsFilterPanel {...filterPanelProps} />

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
                      disabled={catalogStatus === "resolving_workspace"}
                      onChange={(nextWorkspaceId, nextWorkspaceName) =>
                        void handleWorkspaceChange(
                          nextWorkspaceId,
                          nextWorkspaceName,
                        )
                      }
                      workspaceId={workspace?.id ?? dashboardState.workspaceId}
                      workspaceName={
                        workspace?.name ?? dashboardState.workspaceName
                      }
                      workspaces={dashboardState.workspaces}
                    />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <SubmitSkillDialog
                    submissions={submissions}
                    workspaceId={workspace?.id ?? dashboardState.workspaceId}
                  />
                  <SortMenu
                    onChange={(sort) => changeBrowseState({ sort })}
                    options={sortOptions}
                    value={browseState.sort}
                  />
                </div>
              </div>
              {error ? (
                <p className="mb-4 text-xs text-red-600 dark:text-red-300">
                  {error}
                </p>
              ) : null}
              <MySubmissions submissions={submissions} />
              {catalogStatus === "ready" && !error && registryTotal ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  {copy.gallery.communityTotal(registryTotal)}
                </p>
              ) : null}

              {pageLoading ? (
                <SkillsCatalogSkeletonGrid variant={variant} />
              ) : error ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-5 text-sm text-destructive">
                  <p className="font-medium">{copy.gallery.loadFailedTitle}</p>
                  <p className="mt-1 text-destructive/85">{error}</p>
                </div>
              ) : items.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  {filtersActive
                    ? copy.gallery.emptyFiltered
                    : copy.gallery.emptyCatalog}
                </div>
              ) : showSectionHeadings ? (
                <div className="space-y-6">
                  {sectionList.map((section) => (
                    <section aria-label={section.label} key={section.key}>
                      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {section.label}
                      </h2>
                      <div className={gridClassName}>
                        {section.items.map(renderCard)}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className={gridClassName}>{items.map(renderCard)}</div>
              )}
              {catalogStatus === "ready" && nextCursor ? (
                <>
                  {loadMoreFailed ? null : (
                    <LoadMoreSentinel
                      onVisible={() => void loadMore()}
                      watchKey={nextCursor}
                    />
                  )}
                  <div className="flex justify-center py-4">
                    <Button
                      disabled={isLoadingMore}
                      onClick={() => {
                        setLoadMoreFailed(false);
                        void loadMore();
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {isLoadingMore ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      {isLoadingMore
                        ? copy.gallery.loadingMore
                        : copy.gallery.loadMore}
                    </Button>
                  </div>
                </>
              ) : null}
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
          <SkillsFilterPanel {...filterPanelProps} placement="drawer" />
        </SheetContent>
      </Sheet>
      <SkillDetailDialog
        categories={categories}
        item={selectedItem}
        onVersionChanged={() => void refreshCatalog()}
        onInstall={(next) => void installSkill(next)}
        onOpenChange={(open) => {
          if (!open) setSelectedCatalogId(null);
        }}
        onUninstall={(next) => void uninstallSkill(next)}
        pending={pendingCatalogId === selectedCatalogId}
        workspaceId={workspace?.id ?? null}
      />
    </div>
  );
}

"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Github,
  Laptop,
  ListFilter,
  Loader2,
  PanelsTopLeft,
  PlugZap,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ListWorkspaceMarketMcpResponse,
  WorkspaceMcpInstall,
  WorkspaceMcpInstallStatus,
} from "@sourceweft/sdk";
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
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../../../lib/sdk";
import { desktopBridge } from "../../../../lib/desktop-bridge";
import { formatShortRelativeTime } from "../../../../lib/relative-time";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { McpIcon } from "../../_components/dashboard-icons";
import { invalidateWorkspaceMcpCache } from "../../chat/_components/sources-hub/mcp/use-mcp";
import { CredentialsDialog } from "./mcp-credentials-dialog";
import { McpDetailDialog } from "./mcp-detail-dialog";
import { SubmitMcpDialog } from "./submit-mcp-dialog";

type MarketMcpItem = ListWorkspaceMarketMcpResponse["items"][number];
type MarketMcpSummary = MarketMcpItem["market"];
type CategoryKey = "all" | (string & {});
type StatusFilter = "all" | "installed" | "not_installed";
type TrustFilter = "all" | "trusted" | "unverified";
type DeviceFilter = "all" | "web" | "desktop";
type SortKey = "recommended" | "name_asc" | "installed_first" | "trusted_first";
type CatalogStatus =
  | "resolving_workspace"
  | "loading_catalog"
  | "ready"
  | "error";

type ResolvedWorkspace = {
  id: string;
  name: string | null;
};

const catalogRequestsByWorkspace = new Map<
  string,
  Promise<ListWorkspaceMarketMcpResponse>
>();
const categoryRequestsByWorkspace = new Map<
  string,
  Promise<Array<{ key: CategoryKey; label: string }>>
>();

const fallbackCategories: Array<{ key: CategoryKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "developer-tools", label: "Developer Tools" },
  { key: "browser-automation", label: "Browser Automation" },
  { key: "web-search-scraping", label: "Web Search & Scraping" },
  { key: "data-analytics", label: "Data & Analytics" },
  { key: "databases", label: "Databases" },
  { key: "files-storage", label: "Files & Storage" },
  { key: "knowledge-memory", label: "Knowledge & Memory" },
  { key: "productivity-workflow", label: "Productivity & Workflow" },
  {
    key: "communication-collaboration",
    label: "Communication & Collaboration",
  },
  { key: "business-commerce", label: "Business & Commerce" },
  { key: "cloud-infrastructure", label: "Cloud & Infrastructure" },
  { key: "security-monitoring", label: "Security & Monitoring" },
  { key: "finance", label: "Finance" },
  { key: "media-design", label: "Media & Design" },
  { key: "location-lifestyle", label: "Location & Lifestyle" },
  { key: "ai-ml", label: "AI & ML" },
  { key: "other", label: "Other" },
];

const statusOptions: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "installed", label: "Installed" },
  { key: "not_installed", label: "Not installed" },
];

const trustOptions: Array<{ key: TrustFilter; label: string }> = [
  { key: "all", label: "All trust levels" },
  { key: "trusted", label: "Official or verified" },
  { key: "unverified", label: "Unverified" },
];

// The web catalog only ever lists web-executable servers (the backend excludes
// desktop-only entries); the desktop-only facet returns when the desktop host
// ships its own market view.
const deviceOptions: Array<{ key: DeviceFilter; label: string }> = [
  { key: "all", label: "All devices" },
  { key: "web", label: "Web executable" },
];

const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: "recommended", label: "Recommended" },
  { key: "name_asc", label: "Name A-Z" },
  { key: "installed_first", label: "Installed first" },
  { key: "trusted_first", label: "Trusted first" },
];

const CATALOG_PAGE_SIZE = 100;

function fetchMcpCatalog(
  targetWorkspaceId: string,
  params?: { query?: string; category?: string; cursor?: string },
) {
  // Dedupe concurrent identical requests (workspace + filters + page).
  const requestKey = `${targetWorkspaceId}|${params?.query ?? ""}|${params?.category ?? ""}|${params?.cursor ?? ""}`;
  const pending = catalogRequestsByWorkspace.get(requestKey);
  if (pending) {
    return pending;
  }
  const promise = contentClient
    .listWorkspaceMarketMcp(targetWorkspaceId, {
      ...params,
      limit: CATALOG_PAGE_SIZE,
    })
    .finally(() => {
      if (catalogRequestsByWorkspace.get(requestKey) === promise) {
        catalogRequestsByWorkspace.delete(requestKey);
      }
    });
  catalogRequestsByWorkspace.set(requestKey, promise);
  return promise;
}

function fetchMcpCategories(targetWorkspaceId: string) {
  const pending = categoryRequestsByWorkspace.get(targetWorkspaceId);
  if (pending) {
    return pending;
  }
  const promise = contentClient
    .listWorkspaceMarketMcpCategories(targetWorkspaceId)
    .then((response) => [
      { key: "all" as const, label: "All" },
      ...response.items.map((category) => ({
        key: category.slug as CategoryKey,
        label: category.name,
      })),
    ])
    .catch(() => fallbackCategories)
    .finally(() => {
      if (categoryRequestsByWorkspace.get(targetWorkspaceId) === promise) {
        categoryRequestsByWorkspace.delete(targetWorkspaceId);
      }
    });
  categoryRequestsByWorkspace.set(targetWorkspaceId, promise);
  return promise;
}

function categoryForMcp(
  item: MarketMcpSummary,
  categories: Array<{ key: CategoryKey; label: string }>,
): CategoryKey {
  const normalizedCategories = item.categories.map((entry) =>
    entry.trim().toLowerCase(),
  );
  const direct = categories.find(
    (category) =>
      category.key !== "all" && normalizedCategories.includes(category.key),
  );
  if (direct) {
    return direct.key;
  }
  const text =
    `${item.name} ${item.summary} ${item.identifier} ${normalizedCategories.join(" ")}`.toLowerCase();
  if (text.includes("search") || text.includes("crawl"))
    return "web-search-scraping";
  if (
    text.includes("notion") ||
    text.includes("calendar") ||
    text.includes("task")
  )
    return "productivity-workflow";
  if (
    text.includes("slack") ||
    text.includes("email") ||
    text.includes("discord")
  )
    return "communication-collaboration";
  if (
    text.includes("sql") ||
    text.includes("database") ||
    text.includes("warehouse")
  )
    return "databases";
  if (text.includes("github") || text.includes("code") || text.includes("dev"))
    return "developer-tools";
  if (
    text.includes("research") ||
    text.includes("paper") ||
    text.includes("docs")
  )
    return "knowledge-memory";
  return "other";
}

function isTrustedMcp(item: MarketMcpSummary) {
  return item.official || item.verified;
}

function identifierForSearch(identifier: string) {
  return identifier.toLowerCase().replace(/^(?:io|com)\.github\./, "");
}

function queryIncludesTechnicalIdentifierSyntax(query: string) {
  return query.includes(".") || query.includes("/");
}

function sourceLinkForMcp(item: MarketMcpSummary) {
  return item.repoUrl ?? item.sourceUrl;
}

function isGithubSourceUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

function installStatusMeta(status: WorkspaceMcpInstallStatus): {
  dotClass: string;
  label: string;
} {
  if (status === "error") {
    return { dotClass: "bg-red-500", label: "Error" };
  }
  if (status === "disabled") {
    return { dotClass: "bg-muted-foreground/50", label: "Disabled" };
  }
  return { dotClass: "bg-emerald-500", label: "Active" };
}

function McpStatusIndicator({ install }: { install: WorkspaceMcpInstall }) {
  const meta = installStatusMeta(install.status);
  const testedLabel = install.lastTestedAt
    ? `Tested ${formatShortRelativeTime(install.lastTestedAt)}`
    : "Not tested yet";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      title={install.lastError ?? undefined}
    >
      <span
        aria-label={meta.label}
        className={cn("size-1.5 shrink-0 rounded-full", meta.dotClass)}
      />
      <span className="truncate">{testedLabel}</span>
      {install.lastError ? (
        <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />
      ) : null}
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
          options.map((item) => {
            const active = item.id === workspaceId;
            return (
              <DropdownMenuItem
                className="gap-2"
                key={item.id}
                onClick={() => onChange(item.id, item.name)}
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortMenu({
  onChange,
  value,
}: {
  onChange: (value: SortKey) => void;
  value: SortKey;
}) {
  const activeLabel =
    sortOptions.find((option) => option.key === value)?.label ?? "Recommended";
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
        {sortOptions.map((option) => (
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

function McpFilterPanel({
  category,
  categoryCounts,
  desktopCount,
  deviceFilter,
  installedCount,
  onCategoryChange,
  onClear,
  onDeviceFilterChange,
  onQueryChange,
  onStatusFilterChange,
  onTrustFilterChange,
  placement = "desktop",
  query,
  statusFilter,
  totalCount,
  trustFilter,
  unverifiedCount,
  webCount,
  categories,
}: {
  category: CategoryKey;
  categoryCounts: Record<CategoryKey, number>;
  categories: Array<{ key: CategoryKey; label: string }>;
  desktopCount: number;
  deviceFilter: DeviceFilter;
  installedCount: number;
  onCategoryChange: (value: CategoryKey) => void;
  onClear: () => void;
  onDeviceFilterChange: (value: DeviceFilter) => void;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  onTrustFilterChange: (value: TrustFilter) => void;
  placement?: "desktop" | "drawer";
  query: string;
  statusFilter: StatusFilter;
  totalCount: number;
  trustFilter: TrustFilter;
  unverifiedCount: number;
  webCount: number;
}) {
  const notInstalledCount = Math.max(totalCount - installedCount, 0);
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
          <h2 className="text-sm font-semibold text-foreground">MCP Market</h2>
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onClear}
            type="button"
          >
            Clear all
          </button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <FilterFacet defaultOpen label="Search" summary={query.trim() || "all"}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-7 pl-8 text-xs"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search MCP"
              value={query}
            />
          </div>
        </FilterFacet>

        <FilterFacet
          defaultOpen
          label="Category"
          summary={categories.find((item) => item.key === category)?.label}
        >
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

        <FilterFacet
          label="Trust"
          summary={trustOptions.find((item) => item.key === trustFilter)?.label}
        >
          <div className="space-y-1">
            {trustOptions.map((item) => (
              <FacetChoice
                active={trustFilter === item.key}
                count={item.key === "unverified" ? unverifiedCount : undefined}
                key={item.key}
                label={item.label}
                onClick={() => onTrustFilterChange(item.key)}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet
          label="Device"
          summary={
            deviceOptions.find((item) => item.key === deviceFilter)?.label
          }
        >
          <div className="space-y-1">
            {deviceOptions.map((item) => (
              <FacetChoice
                active={deviceFilter === item.key}
                count={
                  item.key === "web"
                    ? webCount
                    : item.key === "desktop"
                      ? desktopCount
                      : totalCount
                }
                key={item.key}
                label={item.label}
                onClick={() => onDeviceFilterChange(item.key)}
              />
            ))}
          </div>
        </FilterFacet>

        <FilterFacet
          label="Status"
          summary={
            statusOptions.find((item) => item.key === statusFilter)?.label
          }
        >
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

function McpSkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <article
          className="flex h-[286px] flex-col rounded-2xl border border-border bg-background p-4 shadow-xs"
          key={index}
        >
          <div className="flex items-center gap-3">
            <div className="size-9 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-auto flex h-11 items-end gap-2 border-t border-border pt-3">
            <div className="h-7 flex-1 animate-pulse rounded-full bg-muted" />
            <div className="size-7 animate-pulse rounded-lg bg-muted" />
            <div className="size-7 animate-pulse rounded-lg bg-muted" />
          </div>
        </article>
      ))}
    </div>
  );
}

function McpCard({
  categories,
  highlight = false,
  isDesktopHost,
  item,
  onConfigure,
  onInstall,
  onOpenDetails,
  onTest,
  onToggleEnabled,
  onUninstall,
  pendingActions,
}: {
  categories: Array<{ key: CategoryKey; label: string }>;
  highlight?: boolean;
  isDesktopHost: boolean;
  item: MarketMcpItem;
  onConfigure: (install: WorkspaceMcpInstall) => void;
  onInstall: (item: MarketMcpItem) => void;
  onOpenDetails: (item: MarketMcpItem) => void;
  onTest: (install: WorkspaceMcpInstall) => void;
  onToggleEnabled: (install: WorkspaceMcpInstall, enabled: boolean) => void;
  onUninstall: (item: MarketMcpItem) => void;
  pendingActions: ReadonlySet<string>;
}) {
  const install = item.install;
  const market = item.market;
  const trusted = isTrustedMcp(market);
  const desktopOnly = market.desktopOnly || !market.webExecutable;
  const installed = Boolean(install);
  const pending =
    pendingActions.has(market.identifier) ||
    (install ? pendingActions.has(install.id) : false);
  const canExecuteHere = !desktopOnly || isDesktopHost;
  const sourceUrl = sourceLinkForMcp(market);
  const sourceIsGithub = sourceUrl ? isGithubSourceUrl(sourceUrl) : false;
  const itemCategory = categoryForMcp(market, categories);
  const itemCategoryLabel =
    categories.find((category) => category.key === itemCategory)?.label ??
    itemCategory;
  const needsCredentials =
    install &&
    install.authType !== "none" &&
    install.credentialStatus !== "configured";
  const [iconFailed, setIconFailed] = React.useState(false);
  const showRegistryIcon = Boolean(market.iconUrl) && !iconFailed;

  React.useEffect(() => {
    setIconFailed(false);
  }, [market.iconUrl]);

  return (
    <article
      className={cn(
        "group flex h-[286px] flex-col overflow-hidden rounded-2xl border border-border bg-background p-4 shadow-xs transition-colors hover:bg-accent/20",
        highlight && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      id={`mcp-card-${market.identifier}`}
    >
      <div className="flex items-start gap-2">
        <button
          aria-label={`View ${market.name} details`}
          className="-m-1 flex min-w-0 flex-1 items-start gap-3 rounded-lg p-1 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenDetails(item)}
          type="button"
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm",
              showRegistryIcon
                ? "border border-border bg-white"
                : trusted
                  ? "bg-linear-to-br from-emerald-500 via-sky-500 to-blue-500 text-white"
                  : "bg-linear-to-br from-amber-500 via-orange-500 to-rose-500 text-white",
            )}
          >
            {showRegistryIcon ? (
              // Registry icons can come from arbitrary verified publisher domains,
              // so Next Image's static remote-host allowlist is not applicable.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt=""
                className="size-full object-contain"
                loading="lazy"
                onError={() => setIconFailed(true)}
                referrerPolicy="no-referrer"
                src={market.iconUrl ?? undefined}
              />
            ) : (
              <McpIcon className="h-4.5 w-4.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold leading-6 text-foreground">
                {market.name}
              </h3>
              {installed ? (
                <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                  <Check className="h-3 w-3" />
                  Installed
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {market.identifier}
            </p>
          </div>
        </button>
        {sourceUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                className="-mr-1 -mt-1 text-muted-foreground hover:text-foreground"
                size="icon-xs"
                variant="ghost"
              >
                <a
                  aria-label={`Open ${market.name} source`}
                  href={sourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {sourceIsGithub ? (
                    <Github className="size-4" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {sourceIsGithub ? "Open GitHub repository" : "Open source"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <button
        className="mt-3 line-clamp-3 min-h-[60px] text-left text-xs leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenDetails(item)}
        type="button"
      >
        {market.summary}
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {market.official ? (
          <Badge className="h-5 px-1.5 text-[10px]" variant="default">
            Official
          </Badge>
        ) : market.verified ? (
          <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
            Verified
          </Badge>
        ) : (
          <Badge className="h-5 gap-1 px-1.5 text-[10px]" variant="outline">
            <AlertTriangle className="h-3 w-3" />
            Unverified
          </Badge>
        )}
        <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
          {desktopOnly ? "Desktop only" : "Web executable"}
        </Badge>
        <Badge className="h-5 px-1.5 text-[10px] capitalize" variant="outline">
          {itemCategoryLabel}
        </Badge>
      </div>

      {!trusted ? (
        <div className="mt-3 flex max-h-11 gap-2 overflow-hidden rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="line-clamp-2">
            Unverified MCP can receive this turn&apos;s tool arguments and may
            perform external actions. Review the server before enabling.
          </span>
        </div>
      ) : null}

      <div className="mt-auto flex h-11 items-center gap-1.5 border-t border-border pt-3">
        {install ? (
          <>
            <div
              className={cn(
                "min-w-0 flex-1 text-[11px] text-muted-foreground",
                needsCredentials && "text-amber-700 dark:text-amber-300",
              )}
              title={
                needsCredentials
                  ? "Credentials required"
                  : `${install.tools.length} tools synced`
              }
            >
              <McpStatusIndicator install={install} />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Test ${market.name}`}
                  disabled={pending || !canExecuteHere}
                  onClick={() => onTest(install)}
                  size="icon-xs"
                  type="button"
                >
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Test connection</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Configure ${market.name}`}
                  className={cn(needsCredentials && "text-amber-600")}
                  disabled={pending}
                  onClick={() => onConfigure(install)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {needsCredentials
                  ? "Configure required credentials"
                  : "Settings"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Uninstall ${market.name}`}
                  disabled={pending}
                  onClick={() => onUninstall(item)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Uninstall</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex h-7 items-center border-l border-border pl-1.5">
                  <Switch
                    aria-label={`${install.enabled ? "Disable" : "Enable"} ${market.name}`}
                    checked={install.enabled}
                    disabled={pending}
                    onCheckedChange={(checked) =>
                      onToggleEnabled(install, checked)
                    }
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {install.enabled ? "Disable" : "Enable"}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Button
            className="w-full rounded-full"
            disabled={pending}
            onClick={() => onInstall(item)}
            size="xs"
            type="button"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <McpIcon className="size-3.5" />
            )}
            Install
          </Button>
        )}
      </div>
    </article>
  );
}

export function McpMarket() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkIdentifier = searchParams.get("mcp");
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(
    null,
  );
  const [items, setItems] = React.useState<MarketMcpItem[]>([]);
  const [categories, setCategories] = React.useState(fallbackCategories);
  const [pendingActions, setPendingActions] = React.useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const [highlightIdentifier, setHighlightIdentifier] = React.useState<
    string | null
  >(null);
  const deepLinkHandledRef = React.useRef(false);

  const startPendingAction = React.useCallback((key: string) => {
    setPendingActions((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const endPendingAction = React.useCallback((key: string) => {
    setPendingActions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<CategoryKey>("all");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [trustFilter, setTrustFilter] = React.useState<TrustFilter>("all");
  const [deviceFilter, setDeviceFilter] = React.useState<DeviceFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("recommended");
  // Server-side catalog paging: the catalog is far larger than one page, so
  // query/category are pushed to the backend (debounced) and further pages are
  // appended via the keyset cursor.
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [serverQuery, setServerQuery] = React.useState("");
  React.useEffect(() => {
    const timeout = window.setTimeout(() => setServerQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const [catalogStatus, setCatalogStatus] = React.useState<CatalogStatus>(
    "resolving_workspace",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [serverCategoryCounts, setServerCategoryCounts] = React.useState<Record<
    string,
    number
  > | null>(null);
  const [serverTotalCount, setServerTotalCount] = React.useState<number | null>(
    null,
  );
  const [filtersDrawerOpen, setFiltersDrawerOpen] = React.useState(false);
  const [credentialsInstall, setCredentialsInstall] =
    React.useState<WorkspaceMcpInstall | null>(null);
  const [selectedIdentifier, setSelectedIdentifier] = React.useState<
    string | null
  >(null);
  const [isDesktopHost, setIsDesktopHost] = React.useState(false);
  const workspaceIdRef = React.useRef<string | null>(null);
  const loadedCatalogWorkspaceIdRef = React.useRef<string | null>(null);
  const catalogGenerationRef = React.useRef(0);

  React.useEffect(() => {
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace?.id]);

  React.useEffect(() => {
    setIsDesktopHost(desktopBridge.isAvailable());
  }, []);

  const resolveWorkspace = React.useCallback(async () => {
    if (!dashboardState.workspaceId && !dashboardState.hasWorkspaceHydrated) {
      return undefined;
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
    dashboardState.hasWorkspaceHydrated,
    dashboardState.workspaceId,
    dashboardState.workspaceName,
  ]);

  const loadCatalog = React.useCallback(async () => {
    const generation = ++catalogGenerationRef.current;
    const currentCatalogWorkspaceId = workspaceIdRef.current;
    const hasCurrentCatalog =
      Boolean(currentCatalogWorkspaceId) &&
      loadedCatalogWorkspaceIdRef.current === currentCatalogWorkspaceId;

    setError(null);
    if (!hasCurrentCatalog) {
      setCatalogStatus("resolving_workspace");
    }

    try {
      const resolved = await resolveWorkspace();
      if (catalogGenerationRef.current !== generation) return;
      if (resolved === undefined) {
        setCatalogStatus("resolving_workspace");
        return;
      }
      setWorkspace(resolved);
      if (!resolved) {
        setItems([]);
        loadedCatalogWorkspaceIdRef.current = null;
        setCatalogStatus("ready");
        return;
      }
      if (loadedCatalogWorkspaceIdRef.current === resolved.id) {
        setCatalogStatus("ready");
        return;
      }
      setItems([]);
      setCatalogStatus("loading_catalog");
      const [result, categoryResult] = await Promise.all([
        fetchMcpCatalog(resolved.id),
        fetchMcpCategories(resolved.id),
      ]);
      if (catalogGenerationRef.current !== generation) return;
      loadedCatalogWorkspaceIdRef.current = resolved.id;
      setItems(result.items);
      setNextCursor(result.nextCursor ?? null);
      setCategories(categoryResult);
      setCatalogStatus("ready");
    } catch (loadError) {
      if (catalogGenerationRef.current !== generation) return;
      setItems([]);
      loadedCatalogWorkspaceIdRef.current = null;
      setCatalogStatus("error");
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load MCP market.",
      );
    }
  }, [resolveWorkspace]);

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Refetch the first page from the server whenever the debounced query or the
  // category changes; the initial default-filter load per workspace is done by
  // loadCatalog and skipped here.
  const filterKeyRef = React.useRef("");
  React.useEffect(() => {
    const targetWorkspaceId = workspace?.id;
    if (!targetWorkspaceId) return;
    const key = `${targetWorkspaceId}|${serverQuery}|${category}`;
    if (filterKeyRef.current === key) return;
    const isFirstForWorkspace = !filterKeyRef.current.startsWith(
      `${targetWorkspaceId}|`,
    );
    filterKeyRef.current = key;
    if (isFirstForWorkspace && !serverQuery && category === "all") return;
    let cancelled = false;
    void fetchMcpCatalog(targetWorkspaceId, {
      query: serverQuery || undefined,
      category: category === "all" ? undefined : category,
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setNextCursor(result.nextCursor ?? null);
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to search the MCP catalog.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, serverQuery, category]);

  React.useEffect(() => {
    const targetWorkspaceId = workspace?.id;
    if (!targetWorkspaceId) return;
    let cancelled = false;
    void contentClient
      .getWorkspaceMarketMcpCategoryCounts(targetWorkspaceId, {
        query: serverQuery || undefined,
      })
      .then((result) => {
        if (cancelled) return;
        setServerCategoryCounts(result.counts);
        setServerTotalCount(result.total);
      })
      .catch(() => {
        if (cancelled) return;
        setServerCategoryCounts(null);
        setServerTotalCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, serverQuery]);

  const loadMoreMcp = React.useCallback(async () => {
    const targetWorkspaceId = workspace?.id;
    if (!targetWorkspaceId || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const result = await fetchMcpCatalog(targetWorkspaceId, {
        query: serverQuery || undefined,
        category: category === "all" ? undefined : category,
        cursor: nextCursor,
      });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.market.identifier));
        return [
          ...current,
          ...result.items.filter((item) => !seen.has(item.market.identifier)),
        ];
      });
      setNextCursor(result.nextCursor ?? null);
    } catch {
      toast.error("Failed to load more MCP servers.");
    } finally {
      setIsLoadingMore(false);
    }
  }, [workspace?.id, nextCursor, isLoadingMore, serverQuery, category]);

  // Honor the ?mcp=<identifier> deep link from the public MCP detail page:
  // once the catalog is loaded, scroll the matching card into view and give it
  // a brief highlight. Runs once per identifier value.
  React.useEffect(() => {
    if (!deepLinkIdentifier || deepLinkHandledRef.current) return;
    if (catalogStatus !== "ready") return;
    const exists = items.some(
      (item) => item.market.identifier === deepLinkIdentifier,
    );
    if (!exists) return;
    deepLinkHandledRef.current = true;
    setHighlightIdentifier(deepLinkIdentifier);
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(`mcp-card-${deepLinkIdentifier}`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timeout = window.setTimeout(() => setHighlightIdentifier(null), 2600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [catalogStatus, deepLinkIdentifier, items]);

  // Surface the result of the OAuth redirect (GET /v1/mcp/oauth/callback bounces
  // back here with ?mcpOAuth=connected|error), then strip the query so a refresh
  // doesn't re-toast.
  const oauthCallbackHandledRef = React.useRef(false);
  React.useEffect(() => {
    const status = searchParams.get("mcpOAuth");
    if (!status || oauthCallbackHandledRef.current) return;
    // Wait for the workspace to resolve before handling — marking handled while
    // workspace is still null would permanently skip the cache invalidation.
    if (!workspace?.id) return;
    oauthCallbackHandledRef.current = true;
    if (status === "connected") {
      toast.success("MCP server connected");
      if (workspace?.id) {
        invalidateWorkspaceMcpCache(workspace.id);
      }
    } else {
      toast.error("MCP authorization failed. Please try again.");
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("mcpOAuth");
    router.replace(
      `/dashboard/mcp${params.toString() ? `?${params.toString()}` : ""}`,
    );
  }, [router, searchParams, workspace?.id]);

  async function handleWorkspaceChange(
    nextWorkspaceId: string,
    nextWorkspaceName: string,
  ) {
    if (nextWorkspaceId === workspace?.id) return;
    workspaceIdRef.current = nextWorkspaceId;
    loadedCatalogWorkspaceIdRef.current = null;
    setSelectedIdentifier(null);
    setWorkspace({ id: nextWorkspaceId, name: nextWorkspaceName });
    setItems([]);
    setError(null);
    setCatalogStatus("loading_catalog");
    try {
      await dashboardState.switchWorkspace(nextWorkspaceId, nextWorkspaceName);
      if (workspaceIdRef.current !== nextWorkspaceId) return;
      const [result, categoryResult] = await Promise.all([
        fetchMcpCatalog(nextWorkspaceId),
        // Refresh categories too, or the facet + bucketing keep the previous
        // workspace's taxonomy after a switch.
        fetchMcpCategories(nextWorkspaceId),
      ]);
      if (workspaceIdRef.current !== nextWorkspaceId) return;
      loadedCatalogWorkspaceIdRef.current = nextWorkspaceId;
      setItems(result.items);
      setCategories(categoryResult);
      setCatalogStatus("ready");
    } catch (changeError) {
      setItems([]);
      loadedCatalogWorkspaceIdRef.current = null;
      setCatalogStatus("error");
      setError(
        changeError instanceof Error
          ? changeError.message
          : "Failed to switch workspace.",
      );
    }
  }

  function updateInstallInItems(nextInstall: WorkspaceMcpInstall) {
    setItems((currentItems) =>
      currentItems.map((item) =>
        item.market.identifier === nextInstall.marketIdentifier
          ? { ...item, install: nextInstall }
          : item.install?.id === nextInstall.id
            ? { ...item, install: nextInstall }
            : item,
      ),
    );
  }

  async function installMcp(item: MarketMcpItem) {
    if (!workspace || item.install) return;
    const workspaceId = workspace.id;
    const pendingKey = item.market.identifier;
    startPendingAction(pendingKey);
    try {
      const result = await contentClient.installMarketMcp(
        workspaceId,
        item.market.identifier,
        {},
      );
      updateInstallInItems(result.install);
      invalidateWorkspaceMcpCache(workspaceId);
      toast.success("MCP installed");
      // Installing an auth server immediately prompts for credentials; the user
      // then Tests to verify the connection. Install and Test stay separate.
      if (result.install.authType !== "none") {
        setCredentialsInstall(result.install);
      }
    } catch (installError) {
      toast.error(
        installError instanceof Error
          ? installError.message
          : "Failed to install MCP.",
      );
    } finally {
      endPendingAction(pendingKey);
    }
  }

  async function uninstallMcp(item: MarketMcpItem) {
    if (!workspace || !item.install) return;
    const workspaceId = workspace.id;
    const installId = item.install.id;
    startPendingAction(installId);
    try {
      await contentClient.deleteWorkspaceMcpInstall(workspaceId, installId);
      setItems((currentItems) =>
        currentItems.map((currentItem) =>
          currentItem.install?.id === installId ||
          currentItem.market.identifier === item.market.identifier
            ? { ...currentItem, install: null }
            : currentItem,
        ),
      );
      invalidateWorkspaceMcpCache(workspaceId);
      toast.success("MCP uninstalled");
    } catch (uninstallError) {
      toast.error(
        uninstallError instanceof Error
          ? uninstallError.message
          : "Failed to uninstall MCP.",
      );
    } finally {
      endPendingAction(installId);
    }
  }

  async function toggleInstall(install: WorkspaceMcpInstall, enabled: boolean) {
    if (!workspace) return;
    const workspaceId = workspace.id;
    startPendingAction(install.id);
    try {
      const result = await contentClient.updateWorkspaceMcpInstall(
        workspaceId,
        install.id,
        { enabled },
      );
      updateInstallInItems(result.install);
      invalidateWorkspaceMcpCache(workspaceId);
      toast.success(enabled ? "MCP enabled" : "MCP disabled");
    } catch (toggleError) {
      toast.error(
        toggleError instanceof Error
          ? toggleError.message
          : "Failed to update MCP.",
      );
    } finally {
      endPendingAction(install.id);
    }
  }

  async function testInstall(install: WorkspaceMcpInstall) {
    if (!workspace) return;
    const workspaceId = workspace.id;
    startPendingAction(install.id);
    try {
      const result = await contentClient.testWorkspaceMcpInstall(
        workspaceId,
        install.id,
      );
      updateInstallInItems(result.install);
      invalidateWorkspaceMcpCache(workspaceId);
      toast.success(`MCP connection tested: ${result.toolCount} tools`);
    } catch (testError) {
      toast.error(
        testError instanceof Error ? testError.message : "Failed to test MCP.",
      );
    } finally {
      endPendingAction(install.id);
    }
  }

  const installedCount = React.useMemo(
    () => items.filter((item) => item.install).length,
    [items],
  );
  const unverifiedCount = React.useMemo(
    () => items.filter((item) => !isTrustedMcp(item.market)).length,
    [items],
  );
  const webCount = React.useMemo(
    () =>
      items.filter(
        (item) => item.market.webExecutable && !item.market.desktopOnly,
      ).length,
    [items],
  );
  const desktopCount = React.useMemo(
    () =>
      items.filter(
        (item) => item.market.desktopOnly || !item.market.webExecutable,
      ).length,
    [items],
  );

  const categoryCounts = React.useMemo(() => {
    const counts = categories.reduce(
      (record, item) => ({ ...record, [item.key]: 0 }),
      {} as Record<CategoryKey, number>,
    );
    // Prefer whole-catalog counts from the server; these mirror the server-side
    // category filter (a DB join over every category an item carries) and cover
    // all matching content, not just the loaded page.
    if (serverCategoryCounts) {
      for (const item of categories) {
        if (item.key === "all") continue;
        counts[item.key] = serverCategoryCounts[item.key] ?? 0;
      }
      counts.all = serverTotalCount ?? items.length;
      return counts;
    }
    // Fallback before the counts response lands: approximate from loaded items.
    counts.all = items.length;
    for (const item of items) {
      const itemCategory = categoryForMcp(item.market, categories);
      counts[itemCategory] = (counts[itemCategory] ?? 0) + 1;
    }
    return counts;
  }, [categories, items, serverCategoryCounts, serverTotalCount]);

  const filteredItems = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      const market = item.market;
      const trusted = isTrustedMcp(market);
      const desktopOnly = market.desktopOnly || !market.webExecutable;
      // Category is filtered SERVER-side (DB join over all of an item's
      // categories). Re-checking here with categoryForMcp — which collapses an
      // item to a single category — hid server-matched items whose first
      // category differed from the selected one.
      if (statusFilter === "installed" && !item.install) return false;
      if (statusFilter === "not_installed" && item.install) return false;
      if (trustFilter === "trusted" && !trusted) return false;
      if (trustFilter === "unverified" && trusted) return false;
      if (deviceFilter === "web" && desktopOnly) return false;
      if (deviceFilter === "desktop" && !desktopOnly) return false;
      if (!q) return true;
      const searchableIdentifier = identifierForSearch(market.identifier);
      return (
        market.name.toLowerCase().includes(q) ||
        market.summary.toLowerCase().includes(q) ||
        searchableIdentifier.includes(q) ||
        (queryIncludesTechnicalIdentifierSyntax(q) &&
          market.identifier.toLowerCase().includes(q)) ||
        market.categories.some((entry) => entry.toLowerCase().includes(q))
      );
    });
    return filtered.sort((a, b) => {
      if (sort === "name_asc")
        return a.market.name.localeCompare(b.market.name);
      if (sort === "installed_first")
        return Number(Boolean(b.install)) - Number(Boolean(a.install));
      if (sort === "trusted_first")
        return Number(isTrustedMcp(b.market)) - Number(isTrustedMcp(a.market));
      return 0;
    });
  }, [deviceFilter, items, query, sort, statusFilter, trustFilter]);

  const clearFilters = React.useCallback(() => {
    setQuery("");
    setCategory("all");
    setStatusFilter("all");
    setTrustFilter("all");
    setDeviceFilter("all");
  }, []);

  const filtersPanel = (
    <McpFilterPanel
      category={category}
      categoryCounts={categoryCounts}
      categories={categories}
      desktopCount={desktopCount}
      deviceFilter={deviceFilter}
      installedCount={installedCount}
      onCategoryChange={setCategory}
      onClear={clearFilters}
      onDeviceFilterChange={setDeviceFilter}
      onQueryChange={setQuery}
      onStatusFilterChange={setStatusFilter}
      onTrustFilterChange={setTrustFilter}
      query={query}
      statusFilter={statusFilter}
      totalCount={items.length}
      trustFilter={trustFilter}
      unverifiedCount={unverifiedCount}
      webCount={webCount}
    />
  );
  const drawerFiltersPanel = (
    <McpFilterPanel
      category={category}
      categoryCounts={categoryCounts}
      categories={categories}
      desktopCount={desktopCount}
      deviceFilter={deviceFilter}
      installedCount={installedCount}
      onCategoryChange={setCategory}
      onClear={clearFilters}
      onDeviceFilterChange={setDeviceFilter}
      onQueryChange={setQuery}
      onStatusFilterChange={setStatusFilter}
      onTrustFilterChange={setTrustFilter}
      placement="drawer"
      query={query}
      statusFilter={statusFilter}
      totalCount={items.length}
      trustFilter={trustFilter}
      unverifiedCount={unverifiedCount}
      webCount={webCount}
    />
  );
  const pageLoading =
    catalogStatus === "resolving_workspace" ||
    catalogStatus === "loading_catalog";
  const catalogReadyForWorkspace = workspace
    ? loadedCatalogWorkspaceIdRef.current === workspace.id
    : false;
  const selectedItem = selectedIdentifier
    ? (items.find((item) => item.market.identifier === selectedIdentifier) ??
      null)
    : null;
  const selectedItemPending = selectedItem
    ? pendingActions.has(selectedItem.market.identifier) ||
      Boolean(
        selectedItem.install && pendingActions.has(selectedItem.install.id),
      )
    : false;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
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
                </div>
                <div className="flex items-center gap-2">
                  {isDesktopHost ? (
                    <Badge
                      className="h-7 gap-1.5 px-2 text-[11px]"
                      variant="outline"
                    >
                      <Laptop className="h-3.5 w-3.5" />
                      Desktop host
                    </Badge>
                  ) : (
                    <Badge
                      className="h-7 gap-1.5 px-2 text-[11px]"
                      variant="outline"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Web runtime
                    </Badge>
                  )}
                  <SubmitMcpDialog />
                  <SortMenu onChange={setSort} value={sort} />
                </div>
              </div>

              {error ? (
                <p className="mb-4 text-xs text-red-600 dark:text-red-300">
                  {error}
                </p>
              ) : null}

              {pageLoading ? (
                <McpSkeletonGrid />
              ) : error ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-5 text-sm text-destructive">
                  <p className="font-medium">MCP market could not be loaded</p>
                  <p className="mt-1 text-destructive/85">{error}</p>
                </div>
              ) : catalogStatus === "ready" &&
                catalogReadyForWorkspace &&
                filteredItems.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  {items.length === 0
                    ? "No MCP servers are available for this workspace."
                    : "No MCP servers match the current filters."}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {filteredItems.map((item) => (
                    <McpCard
                      categories={categories}
                      highlight={item.market.identifier === highlightIdentifier}
                      isDesktopHost={isDesktopHost}
                      item={item}
                      key={item.market.identifier}
                      onConfigure={setCredentialsInstall}
                      onInstall={(next) => void installMcp(next)}
                      onOpenDetails={(next) =>
                        setSelectedIdentifier(next.market.identifier)
                      }
                      onTest={(install) => void testInstall(install)}
                      onToggleEnabled={(install, enabled) =>
                        void toggleInstall(install, enabled)
                      }
                      onUninstall={(next) => void uninstallMcp(next)}
                      pendingActions={pendingActions}
                    />
                  ))}
                </div>
              )}
              {catalogStatus === "ready" && nextCursor ? (
                <div className="flex justify-center py-4">
                  <Button
                    disabled={isLoadingMore}
                    onClick={() => void loadMoreMcp()}
                    type="button"
                    variant="outline"
                  >
                    {isLoadingMore ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Load more
                  </Button>
                </div>
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
          <SheetTitle className="sr-only">MCP filters</SheetTitle>
          {drawerFiltersPanel}
        </SheetContent>
      </Sheet>

      <McpDetailDialog
        item={selectedItem}
        onConfigure={setCredentialsInstall}
        onInstall={(next) => void installMcp(next)}
        onOpenChange={(open) => {
          if (!open) setSelectedIdentifier(null);
        }}
        onTest={(install) => void testInstall(install)}
        onToggleEnabled={(install, enabled) =>
          void toggleInstall(install, enabled)
        }
        onUninstall={(next) => void uninstallMcp(next)}
        pending={selectedItemPending}
        workspaceId={workspace?.id ?? null}
      />

      <CredentialsDialog
        install={credentialsInstall}
        onClose={() => setCredentialsInstall(null)}
        onSaved={updateInstallInItems}
        open={Boolean(credentialsInstall)}
        workspaceId={workspace?.id ?? null}
      />
    </div>
  );
}

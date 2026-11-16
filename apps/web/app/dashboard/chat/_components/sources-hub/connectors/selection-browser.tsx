import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import type {
  ConnectorSelectionBrowseResult,
  ConnectorSelectionEntry,
  ConnectorSelectionItem,
  ConnectorSelectionSpec,
} from "@sourceweft/sdk";
import { HttpClientError } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@sourceweft/ui-web/components/ui/breadcrumb";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";

import { connectorsClient } from "../../../../../../lib/sdk";
import {
  browserNote,
  byTypeOrDefault,
  disabledReasonText,
  displayName,
  emptyRootText,
  helpLinkLabel,
  rootLabel,
} from "./selection-copy";
import { selectionErrorKey, toggleSelection } from "./selection";
import {
  selectionIconFor,
  selectionPresenterFor,
} from "./selection-presenters";

const SEARCH_DEBOUNCE_MS = 300;

type Listing = {
  entries: ConnectorSelectionEntry[];
  cursor: string;
  hasMore: boolean;
};

type ContainerView = {
  container: ConnectorSelectionBrowseResult["container"];
  breadcrumbs: ConnectorSelectionBrowseResult["breadcrumbs"];
  helpLink: ConnectorSelectionBrowseResult["helpLink"];
  listing: Listing;
};

type SearchView = { query: string; listing: Listing };

function selectionErrorKeyFromError(error: unknown): string {
  return selectionErrorKey(
    error instanceof HttpClientError ? error.code : undefined,
  );
}

/**
 * Our own browse dialog for picking a connector's selectable items. It is
 * nested inside the connector settings dialog; Radix keeps the two layers
 * apart, so closing this one leaves the settings open.
 *
 * Items already in the connector's selection show as checked and locked, so
 * `onConfirm` receives only the newly picked items (the caller merges them).
 * `onConfirm` resolves whether the selection was saved; the dialog closes
 * only when it was.
 */
export function SelectionBrowser({
  open,
  onOpenChange,
  workspaceId,
  connectorId,
  connectorType,
  providerName,
  spec,
  initialSelection,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  providerName: string;
  spec: ConnectorSelectionSpec;
  initialSelection: readonly ConnectorSelectionItem[];
  onConfirm: (items: ConnectorSelectionItem[]) => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[min(640px,calc(100vw-1rem))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>
            {t("connectors.selection.browser.title", { provider: providerName })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {byTypeOrDefault(t, connectorType, "browser.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Content unmounts when the dialog closes, so every open starts
            fresh at the root with nothing picked. */}
        <SelectionBrowserBody
          connectorId={connectorId}
          connectorType={connectorType}
          initialSelection={initialSelection}
          onCancel={() => onOpenChange(false)}
          onConfirm={async (items) => {
            const saved = await onConfirm(items);
            if (saved) onOpenChange(false);
          }}
          providerName={providerName}
          spec={spec}
          workspaceId={workspaceId}
        />
      </DialogContent>
    </Dialog>
  );
}

function SelectionBrowserBody({
  workspaceId,
  connectorId,
  connectorType,
  providerName,
  spec,
  initialSelection,
  onCancel,
  onConfirm,
}: {
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  providerName: string;
  spec: ConnectorSelectionSpec;
  initialSelection: readonly ConnectorSelectionItem[];
  onCancel: () => void;
  onConfirm: (items: ConnectorSelectionItem[]) => Promise<void>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const presenter = selectionPresenterFor(connectorType);
  const searchEnabled = Boolean(spec.actions.search);
  const [containerView, setContainerView] = useState<ContainerView | null>(
    null,
  );
  const [containerLoading, setContainerLoading] = useState(true);
  const [searchView, setSearchView] = useState<SearchView | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [picked, setPicked] = useState<ConnectorSelectionItem[]>([]);
  const [confirming, setConfirming] = useState(false);
  // Each new container or search request bumps its counter; a response applies
  // only while its request is still the latest one. Refresh and a search
  // started while a browse is in flight (or the reverse) all go through these.
  const containerRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  // The container we last navigated to (null at the root), so Refresh can
  // reload it even while its first listing is still in flight.
  const currentContainerIdRef = useRef<string | null>(null);

  const searching = searchQuery.length > 0 && query.trim().length > 0;
  const initialIds = new Set(initialSelection.map((item) => item.id));
  const pickedIds = new Set(picked.map((item) => item.id));

  const openContainer = useCallback(
    async (containerId: string | null) => {
      const requestId = ++containerRequestRef.current;
      currentContainerIdRef.current = containerId;
      setContainerLoading(true);
      setErrorKey(null);
      try {
        const result = await connectorsClient.selectionBrowse(
          workspaceId,
          connectorId,
          containerId ? { containerId } : {},
        );
        if (requestId !== containerRequestRef.current) return;
        setContainerView({
          container: result.container,
          breadcrumbs: result.breadcrumbs,
          helpLink: result.helpLink,
          listing: {
            entries: result.entries,
            cursor: result.cursor,
            hasMore: result.hasMore,
          },
        });
      } catch (error) {
        if (requestId !== containerRequestRef.current) return;
        setErrorKey(selectionErrorKeyFromError(error));
      } finally {
        if (requestId === containerRequestRef.current) {
          setContainerLoading(false);
        }
      }
    },
    [workspaceId, connectorId],
  );

  const runSearch = useCallback(
    async (queryValue: string) => {
      const requestId = ++searchRequestRef.current;
      setSearchLoading(true);
      setErrorKey(null);
      try {
        const result = await connectorsClient.selectionSearch(
          workspaceId,
          connectorId,
          { query: queryValue },
        );
        if (requestId !== searchRequestRef.current) return;
        setSearchView({
          query: queryValue,
          listing: {
            entries: result.entries,
            cursor: result.cursor,
            hasMore: result.hasMore,
          },
        });
      } catch (error) {
        if (requestId !== searchRequestRef.current) return;
        setErrorKey(selectionErrorKeyFromError(error));
      } finally {
        if (requestId === searchRequestRef.current) setSearchLoading(false);
      }
    },
    [workspaceId, connectorId],
  );

  useEffect(() => {
    void openContainer(null);
  }, [openContainer]);

  useEffect(() => {
    if (!searchEnabled) return;
    const timer = setTimeout(
      () => setSearchQuery(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query, searchEnabled]);

  useEffect(() => {
    if (!searchQuery) {
      // Abandon any in-flight search so a late response cannot reappear.
      searchRequestRef.current += 1;
      setSearchView(null);
      setSearchLoading(false);
      return;
    }
    void runSearch(searchQuery);
  }, [runSearch, searchQuery]);

  function enterContainer(containerId: string | null) {
    // Leaving search for a container clears the query so the container shows.
    setQuery("");
    setSearchQuery("");
    void openContainer(containerId);
  }

  function refresh() {
    if (searching && searchView) {
      void runSearch(searchView.query);
    } else {
      void openContainer(currentContainerIdRef.current);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    setErrorKey(null);
    try {
      if (searching && searchView) {
        const requestId = searchRequestRef.current;
        const result = await connectorsClient.selectionSearch(
          workspaceId,
          connectorId,
          { query: searchView.query, cursor: searchView.listing.cursor },
        );
        if (requestId !== searchRequestRef.current) return;
        setSearchView((current) =>
          current
            ? { ...current, listing: appendPage(current.listing, result) }
            : current,
        );
      } else if (containerView) {
        const requestId = containerRequestRef.current;
        // A continuation page carries no container or breadcrumbs; keep the
        // first page's.
        const result = await connectorsClient.selectionBrowse(
          workspaceId,
          connectorId,
          { cursor: containerView.listing.cursor },
        );
        if (requestId !== containerRequestRef.current) return;
        setContainerView((current) =>
          current
            ? { ...current, listing: appendPage(current.listing, result) }
            : current,
        );
      }
    } catch (error) {
      setErrorKey(selectionErrorKeyFromError(error));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleAdd() {
    if (initialSelection.length + picked.length > spec.maxItems) {
      toast.error(
        t("connectors.selection.limitReached", { limit: spec.maxItems }),
      );
      return;
    }
    setConfirming(true);
    try {
      await onConfirm(picked);
    } finally {
      setConfirming(false);
    }
  }

  const listing = searching
    ? (searchView?.listing ?? null)
    : containerView?.listing;
  const loading = searching ? searchLoading : containerLoading;
  const container = containerView?.container ?? null;
  const breadcrumbs = containerView?.breadcrumbs ?? [];
  const helpLink = containerView?.helpLink ?? null;
  const helpLabel = helpLink
    ? helpLinkLabel(t, connectorType, helpLink.code)
    : null;
  const note = browserNote(t, connectorType);

  return (
    <>
      <div className="space-y-2">
        {searchEnabled ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("connectors.selection.browser.searchLabel", {
                provider: providerName,
              })}
              className="h-8 pl-8 text-xs"
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("connectors.selection.browser.searchPlaceholder", {
                provider: providerName,
              })}
              type="search"
              value={query}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Breadcrumb
            aria-label={t("connectors.selection.browser.breadcrumbLabel")}
            className="min-w-0 flex-1"
          >
            <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
              <BreadcrumbItem>
                {container ? (
                  <CrumbButton onClick={() => enterContainer(null)}>
                    {rootLabel(t, connectorType, providerName)}
                  </CrumbButton>
                ) : (
                  <BreadcrumbPage>
                    {rootLabel(t, connectorType, providerName)}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {breadcrumbs.map((crumb) => (
                <Fragment key={crumb.id}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <CrumbButton onClick={() => enterContainer(crumb.id)}>
                      {displayName(t, crumb.name, crumb.id)}
                    </CrumbButton>
                  </BreadcrumbItem>
                </Fragment>
              ))}
              {container ? (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>
                      {displayName(t, container.name, container.id)}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : null}
            </BreadcrumbList>
          </Breadcrumb>
          <Button
            aria-label={t("connectors.selection.browser.refresh")}
            className="size-7 shrink-0"
            disabled={confirming}
            onClick={refresh}
            size="icon-xs"
            title={t("connectors.selection.browser.refresh")}
            type="button"
            variant="ghost"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {errorKey ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t(errorKey, { provider: providerName })}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="min-h-48 overflow-y-auto rounded-md border">
        {loading || !listing ? (
          loading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          ) : null
        ) : listing.entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {searching
              ? t("connectors.selection.browser.noResults")
              : container
                ? t("connectors.selection.browser.emptyContainer")
                : emptyRootText(t, connectorType)}
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {listing.entries.map((entry) => {
                const name = displayName(t, entry.name, entry.id);
                const alreadyAdded = initialIds.has(entry.id);
                const checked = alreadyAdded || pickedIds.has(entry.id);
                const reason = alreadyAdded
                  ? t("connectors.selection.browser.alreadyAdded")
                  : !entry.selectable
                    ? disabledReasonText(
                        t,
                        connectorType,
                        entry.disabledReason ?? "unknown",
                      )
                    : undefined;
                const Icon = selectionIconFor(
                  presenter,
                  entry.kind,
                  entry.expandable,
                );
                return (
                  <li
                    aria-disabled={!entry.selectable || undefined}
                    className={`flex items-center gap-3 px-3 py-1.5 ${!entry.selectable ? "opacity-50" : ""}`}
                    data-selection-entry={entry.name}
                    key={entry.id}
                    title={reason}
                  >
                    <Checkbox
                      aria-label={t("connectors.selection.browser.select", {
                        name,
                      })}
                      checked={checked}
                      disabled={!entry.selectable || alreadyAdded || confirming}
                      onCheckedChange={() =>
                        setPicked((current) =>
                          toggleSelection(current, {
                            id: entry.id,
                            kind: entry.kind,
                          }),
                        )
                      }
                    />
                    {entry.expandable ? (
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        onClick={() => enterContainer(entry.id)}
                        type="button"
                      >
                        <EntryLabel
                          detail={searching ? entry.detail : null}
                          icon={Icon}
                          name={name}
                          reason={reason}
                        />
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <EntryLabel
                          detail={searching ? entry.detail : null}
                          icon={Icon}
                          name={name}
                          reason={reason}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {listing.hasMore ? (
              <div className="border-t p-2 text-center">
                <Button
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {loadingMore ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  {t("connectors.selection.browser.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {helpLink && helpLabel ? (
        <a
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          href={helpLink.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink className="size-3" />
          {helpLabel}
        </a>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          <p className="font-medium text-foreground tabular-nums">
            {t("connectors.selection.browser.selectedCount", {
              count: picked.length,
            })}
          </p>
          {note ? <p>{note}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button
            disabled={confirming}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("connectors.selection.browser.cancel")}
          </Button>
          <Button
            disabled={confirming || picked.length === 0}
            onClick={() => void handleAdd()}
            size="sm"
            type="button"
          >
            {confirming ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("connectors.selection.browser.add")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function appendPage(
  listing: Listing,
  page: {
    entries: ConnectorSelectionEntry[];
    cursor: string;
    hasMore: boolean;
  },
): Listing {
  return {
    entries: [...listing.entries, ...page.entries],
    cursor: page.cursor,
    hasMore: page.hasMore,
  };
}

function CrumbButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="rounded-sm transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function EntryLabel({
  icon: Icon,
  name,
  detail,
  reason,
}: {
  icon: LucideIcon;
  name: string;
  detail: string | null;
  reason?: string;
}) {
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block truncate text-xs text-foreground">{name}</span>
        {detail ? (
          <span className="block truncate text-[10px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
        {reason ? (
          <span className="block truncate text-[10px] text-muted-foreground">
            {reason}
          </span>
        ) : null}
      </span>
    </>
  );
}

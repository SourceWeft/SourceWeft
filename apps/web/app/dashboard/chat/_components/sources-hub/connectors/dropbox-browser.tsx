import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FileText,
  Folder,
  Loader2,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

import type {
  DropboxBrowseEntry,
  DropboxBrowseFolder,
  DropboxBrowseResult,
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
  DROPBOX_MAX_FILES,
  dropboxErrorKey,
  toggleDropboxSelection,
  type DropboxSelectionItem,
} from "./dropbox-selection";

const SEARCH_DEBOUNCE_MS = 300;

type Listing = {
  entries: DropboxBrowseEntry[];
  cursor: string;
  hasMore: boolean;
};

type FolderView = {
  folder: DropboxBrowseFolder | null;
  breadcrumbs: DropboxBrowseResult["breadcrumbs"];
  listing: Listing;
};

type SearchView = { query: string; listing: Listing };

function errorCode(error: unknown): string | undefined {
  return error instanceof HttpClientError ? error.code : undefined;
}

/**
 * Our own browse dialog for picking Dropbox files and folders. It is nested
 * inside the connector settings dialog; Radix keeps the two layers apart, so
 * closing this one leaves the settings open.
 *
 * Items already in the connector's selection show as checked and locked, so
 * `onConfirm` receives only the newly picked items (the caller merges them,
 * as Drive does with its picker). `onConfirm` resolves whether the selection
 * was saved; the dialog closes only when it was.
 */
export function DropboxBrowser({
  open,
  onOpenChange,
  workspaceId,
  connectorId,
  initialSelection,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  connectorId: string;
  initialSelection: readonly DropboxSelectionItem[];
  onConfirm: (items: DropboxSelectionItem[]) => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[min(640px,calc(100vw-1rem))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>{t("connectors.dropbox.browser.title")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("connectors.dropbox.browser.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Content unmounts when the dialog closes, so every open starts
            fresh at the root with nothing picked. */}
        <DropboxBrowserBody
          connectorId={connectorId}
          initialSelection={initialSelection}
          onCancel={() => onOpenChange(false)}
          onConfirm={async (items) => {
            const saved = await onConfirm(items);
            if (saved) onOpenChange(false);
          }}
          workspaceId={workspaceId}
        />
      </DialogContent>
    </Dialog>
  );
}

function DropboxBrowserBody({
  workspaceId,
  connectorId,
  initialSelection,
  onCancel,
  onConfirm,
}: {
  workspaceId: string;
  connectorId: string;
  initialSelection: readonly DropboxSelectionItem[];
  onCancel: () => void;
  onConfirm: (items: DropboxSelectionItem[]) => Promise<void>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [folderView, setFolderView] = useState<FolderView | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);
  const [searchView, setSearchView] = useState<SearchView | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [picked, setPicked] = useState<DropboxSelectionItem[]>([]);
  const [confirming, setConfirming] = useState(false);
  // Each new folder or search request bumps its counter; a response applies
  // only while its request is still the latest one.
  const folderRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  const searching = searchQuery.length > 0 && query.trim().length > 0;
  const initialIds = new Set(initialSelection.map((item) => item.id));
  const pickedIds = new Set(picked.map((item) => item.id));

  const openFolder = useCallback(
    async (folderId: string | null) => {
      const requestId = ++folderRequestRef.current;
      setFolderLoading(true);
      setErrorKey(null);
      try {
        const result = await connectorsClient.dropboxBrowse(
          workspaceId,
          connectorId,
          folderId ? { folderId } : {},
        );
        if (requestId !== folderRequestRef.current) return;
        setFolderView({
          folder: result.folder,
          breadcrumbs: result.breadcrumbs,
          listing: {
            entries: result.entries,
            cursor: result.cursor,
            hasMore: result.hasMore,
          },
        });
      } catch (error) {
        if (requestId !== folderRequestRef.current) return;
        setErrorKey(dropboxErrorKey(errorCode(error)));
      } finally {
        if (requestId === folderRequestRef.current) setFolderLoading(false);
      }
    },
    [workspaceId, connectorId],
  );

  useEffect(() => {
    void openFolder(null);
  }, [openFolder]);

  useEffect(() => {
    const timer = setTimeout(
      () => setSearchQuery(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    if (!searchQuery) {
      setSearchView(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    setErrorKey(null);
    connectorsClient
      .dropboxSearch(workspaceId, connectorId, { query: searchQuery })
      .then((result) => {
        if (requestId !== searchRequestRef.current) return;
        setSearchView({
          query: searchQuery,
          listing: {
            entries: result.entries,
            cursor: result.cursor,
            hasMore: result.hasMore,
          },
        });
      })
      .catch((error: unknown) => {
        if (requestId !== searchRequestRef.current) return;
        setErrorKey(dropboxErrorKey(errorCode(error)));
      })
      .finally(() => {
        if (requestId === searchRequestRef.current) setSearchLoading(false);
      });
  }, [workspaceId, connectorId, searchQuery]);

  function enterFolder(folderId: string | null) {
    // Leaving search for a folder clears the query so the folder shows.
    setQuery("");
    setSearchQuery("");
    void openFolder(folderId);
  }

  async function loadMore() {
    setLoadingMore(true);
    setErrorKey(null);
    try {
      if (searching && searchView) {
        const requestId = searchRequestRef.current;
        const result = await connectorsClient.dropboxSearch(
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
      } else if (folderView) {
        const requestId = folderRequestRef.current;
        // A continuation page carries no folder or breadcrumbs; keep the
        // first page's.
        const result = await connectorsClient.dropboxBrowse(
          workspaceId,
          connectorId,
          { cursor: folderView.listing.cursor },
        );
        if (requestId !== folderRequestRef.current) return;
        setFolderView((current) =>
          current
            ? { ...current, listing: appendPage(current.listing, result) }
            : current,
        );
      }
    } catch (error) {
      setErrorKey(dropboxErrorKey(errorCode(error)));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleAdd() {
    setConfirming(true);
    try {
      await onConfirm(picked);
    } finally {
      setConfirming(false);
    }
  }

  const listing = searching
    ? (searchView?.listing ?? null)
    : folderView?.listing;
  const loading = searching ? searchLoading : folderLoading;
  const folder = folderView?.folder ?? null;
  const breadcrumbs = folderView?.breadcrumbs ?? [];

  return (
    <>
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("connectors.dropbox.browser.searchLabel")}
            className="h-8 pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("connectors.dropbox.browser.searchPlaceholder")}
            type="search"
            value={query}
          />
        </div>
        <Breadcrumb
          aria-label={t("connectors.dropbox.browser.breadcrumbLabel")}
        >
          <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
            <BreadcrumbItem>
              {folder ? (
                <CrumbButton onClick={() => enterFolder(null)}>
                  {t("connectors.dropbox.browser.root")}
                </CrumbButton>
              ) : (
                <BreadcrumbPage>
                  {t("connectors.dropbox.browser.root")}
                </BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {breadcrumbs.map((crumb) => (
              <Fragment key={crumb.id}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <CrumbButton onClick={() => enterFolder(crumb.id)}>
                    {crumb.name}
                  </CrumbButton>
                </BreadcrumbItem>
              </Fragment>
            ))}
            {folder ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{folder.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        {errorKey ? (
          <Alert variant="destructive">
            <AlertDescription>{t(errorKey)}</AlertDescription>
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
              ? t("connectors.dropbox.browser.noResults")
              : t("connectors.dropbox.browser.emptyFolder")}
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {listing.entries.map((entry) => {
                const alreadyAdded = initialIds.has(entry.id);
                const unavailable = !entry.supported;
                const checked = alreadyAdded || pickedIds.has(entry.id);
                const title = unavailable
                  ? t("connectors.dropbox.browser.unsupported")
                  : alreadyAdded
                    ? t("connectors.dropbox.browser.alreadyAdded")
                    : undefined;
                const Icon = entry.kind === "folder" ? Folder : FileText;
                return (
                  <li
                    aria-disabled={unavailable || undefined}
                    className={`flex items-center gap-3 px-3 py-1.5 ${unavailable ? "opacity-50" : ""}`}
                    data-dropbox-entry={entry.name}
                    key={entry.id}
                    title={title}
                  >
                    <Checkbox
                      aria-label={t("connectors.dropbox.browser.select", {
                        name: entry.name,
                      })}
                      checked={checked}
                      disabled={unavailable || alreadyAdded || confirming}
                      onCheckedChange={() =>
                        setPicked((current) =>
                          toggleDropboxSelection(current, {
                            id: entry.id,
                            kind: entry.kind,
                          }),
                        )
                      }
                    />
                    {entry.kind === "folder" ? (
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        onClick={() => enterFolder(entry.id)}
                        type="button"
                      >
                        <EntryLabel
                          icon={Icon}
                          name={entry.name}
                          path={searching ? entry.pathDisplay : null}
                        />
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <EntryLabel
                          icon={Icon}
                          name={entry.name}
                          path={searching ? entry.pathDisplay : null}
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
                  {t("connectors.dropbox.browser.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          <p className="font-medium text-foreground tabular-nums">
            {t("connectors.dropbox.browser.selectedCount", {
              count: picked.length,
            })}
          </p>
          <p>
            {t("connectors.dropbox.browser.folderNote", {
              limit: DROPBOX_MAX_FILES,
            })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={confirming}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("connectors.dropbox.browser.cancel")}
          </Button>
          <Button
            disabled={confirming || picked.length === 0}
            onClick={() => void handleAdd()}
            size="sm"
            type="button"
          >
            {confirming ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("connectors.dropbox.browser.add")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function appendPage(
  listing: Listing,
  page: { entries: DropboxBrowseEntry[]; cursor: string; hasMore: boolean },
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
  path,
}: {
  icon: LucideIcon;
  name: string;
  path: string | null;
}) {
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block truncate text-xs text-foreground">{name}</span>
        {path ? (
          <span className="block truncate text-[10px] text-muted-foreground">
            {path}
          </span>
        ) : null}
      </span>
    </>
  );
}

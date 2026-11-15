import { formatDisplayDate } from "@/lib/i18n/format";

import { useCallback, useEffect, useState } from "react";
import { FileText, Folder, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLocale as useDisplayLocale, useTranslations } from "next-intl";

import type {
  ConnectorActivityItem,
  DropboxDescribeItem,
} from "@sourceweft/sdk";
import { readConnectorSkippedItems } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";

import { connectorsClient, contentClient } from "../../../../../../lib/sdk";
import { DropboxBrowser } from "./dropbox-browser";
import {
  DROPBOX_MAX_SELECTED_ITEMS,
  dropboxExternalId,
  dropboxFolderFileCount,
  dropboxItemState,
  dropboxSkipReasonKey,
  mergeDropboxSelection,
  readDropboxSelection,
  removeDropboxItem,
  type DropboxFileState,
  type DropboxSelectionItem,
} from "./dropbox-selection";
import type { ConnectorItem } from "./types";

type SourceRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** `dropbox.describe` accepts at most this many ids per call. */
const DESCRIBE_CHUNK_SIZE = 100;

function stateBadgeVariant(kind: DropboxFileState["kind"]): BadgeVariant {
  if (kind === "failed" || kind === "skipped") return "destructive";
  if (kind === "indexed") return "secondary";
  return "outline";
}

async function describeInChunks(
  workspaceId: string,
  connectorId: string,
  ids: string[],
): Promise<DropboxDescribeItem[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += DESCRIBE_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + DESCRIBE_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      connectorsClient.dropboxDescribe(workspaceId, connectorId, {
        ids: chunk,
      }),
    ),
  );
  return results.flatMap((result) => result.items);
}

/**
 * The Dropbox connector's selected files and folders in its settings. The
 * config stores ids only, so folder names, folder paths (for the indexed-file
 * count) and the "no longer exists" mark come from `dropbox.describe`; file
 * names come from the file's source or skipped item first, and from describe
 * only when neither names it. Mirrors GoogleDriveFiles.
 */
export function DropboxItems({
  connector,
  latestSyncRun,
  disabled,
  onChangeItems,
}: {
  connector: ConnectorItem;
  latestSyncRun: ConnectorActivityItem | null;
  disabled: boolean;
  onChangeItems: (items: DropboxSelectionItem[]) => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const displayLocale = useDisplayLocale();
  const workspaceId = connector.raw.workspaceId;
  const connectorId = connector.id;

  const items = readDropboxSelection(connector.raw.configJson);
  const itemsKey = items.map((item) => `${item.kind}:${item.id}`).join(",");
  const folders = items.filter((item) => item.kind === "folder");
  const files = items.filter((item) => item.kind === "file");

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [described, setDescribed] = useState<Map<string, DropboxDescribeItem>>(
    () => new Map(),
  );
  // The describe request whose answer is shown; `null` until the first one
  // settles, so rows wait for names instead of flashing raw ids.
  const [describedKey, setDescribedKey] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  // When this session last submitted an add or remove. Feeds the "unavailable"
  // vs "waiting" decision, as in GoogleDriveFiles. Reset when the connector
  // changes.
  const [selectionChangedAt, setSelectionChangedAt] = useState<Date | null>(
    null,
  );

  const latestRunId = latestSyncRun?.id ?? null;
  const latestRunStatus = latestSyncRun?.status ?? null;

  useEffect(() => {
    setSelectionChangedAt(null);
    setDescribed(new Map());
    setDescribedKey(null);
  }, [connectorId]);

  useEffect(() => {
    let active = true;
    setIsLoadingSources(true);
    contentClient
      .listSources(workspaceId, { connectorId })
      .then((result) => {
        if (active) setSources(result.items);
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setIsLoadingSources(false);
      });
    return () => {
      active = false;
    };
    // Reload when the selection changes or a run advances, so row states
    // (indexed / processing) and folder counts reflect the latest sync.
  }, [workspaceId, connectorId, itemsKey, latestRunId, latestRunStatus]);

  const sourceByExternalId = new Map<string, SourceRecord>();
  for (const source of sources) {
    if (source.externalId) {
      sourceByExternalId.set(source.externalId, source);
    }
  }

  const skippedItems = readConnectorSkippedItems(latestSyncRun?.resultJson);
  const skippedTitleByExternalId = new Map<string, string>();
  for (const skipped of skippedItems) {
    const title = skipped.title?.trim();
    if (title) skippedTitleByExternalId.set(skipped.externalId, title);
  }
  const latestRun = latestSyncRun
    ? {
        status: latestSyncRun.status,
        startedAt: new Date(latestSyncRun.startedAt ?? latestSyncRun.createdAt),
        skippedItems,
      }
    : null;

  // Folders always need describe; a file only when neither its source nor a
  // skipped item names it. Wait for the sources so files are not described
  // needlessly.
  const describeIds = isLoadingSources
    ? []
    : [
        ...folders.map((item) => item.id),
        ...files
          .filter((item) => {
            const externalId = dropboxExternalId(item.id);
            return (
              !sourceByExternalId.get(externalId)?.title?.trim() &&
              !skippedTitleByExternalId.has(externalId)
            );
          })
          .map((item) => item.id),
      ];
  const describeKey = describeIds.join(",");

  useEffect(() => {
    if (!describeKey) return;
    let active = true;
    describeInChunks(workspaceId, connectorId, describeKey.split(","))
      .then((result) => {
        if (active)
          setDescribed(new Map(result.map((item) => [item.id, item])));
      })
      .catch(() => {
        // Names fall back to ids; the rows stay usable.
        if (active) setDescribed(new Map());
      })
      .finally(() => {
        if (active) setDescribedKey(describeKey);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, connectorId, describeKey]);

  const awaitingNames = describeKey !== "" && describedKey === null;
  const isLoading = (isLoadingSources || awaitingNames) && items.length > 0;

  const handleConfirm = useCallback(
    async (picked: DropboxSelectionItem[]) => {
      const current = readDropboxSelection(connector.raw.configJson);
      const result = mergeDropboxSelection(current, picked);
      if (!result.ok) {
        toast.error(
          t("connectors.dropbox.limitReached", { limit: result.limit }),
        );
        return false;
      }
      if (result.added === 0) {
        return true;
      }
      const saved = await onChangeItems(result.items);
      if (saved) setSelectionChangedAt(new Date());
      return saved;
    },
    [connector.raw.configJson, onChangeItems, t],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const current = readDropboxSelection(connector.raw.configJson);
      if (await onChangeItems(removeDropboxItem(current, id))) {
        setSelectionChangedAt(new Date());
      }
    },
    [connector.raw.configJson, onChangeItems],
  );

  function removeButton(id: string, name: string) {
    const label = t("connectors.dropbox.remove", { name });
    return (
      <Button
        className="size-7 shrink-0"
        disabled={disabled}
        onClick={() => void handleRemove(id)}
        size="icon-xs"
        title={label}
        type="button"
        variant="ghost"
      >
        <Trash2 className="size-3.5" />
        <span className="sr-only">{label}</span>
      </Button>
    );
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("connectors.dropbox.itemsTitle")}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            {t("connectors.dropbox.itemsDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {t("connectors.dropbox.count", {
              count: items.length,
              limit: DROPBOX_MAX_SELECTED_ITEMS,
            })}
          </span>
          <Button
            disabled={disabled}
            onClick={() => setBrowserOpen(true)}
            size="xs"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            {t("connectors.dropbox.chooseFiles")}
          </Button>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-md border">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t("connectors.dropbox.empty")}
          </p>
        ) : (
          <div className="max-h-72 divide-y overflow-y-auto">
            {folders.length > 0 ? (
              <section aria-label={t("connectors.dropbox.foldersGroup")}>
                <p className="bg-muted/40 px-3 py-1 text-[10px] font-medium text-muted-foreground">
                  {t("connectors.dropbox.foldersGroup")}
                </p>
                <ul className="divide-y">
                  {folders.map((item) => {
                    const info = described.get(item.id);
                    const name = info?.name?.trim() || item.id;
                    const missing = info?.exists === false;
                    const count =
                      !missing && info?.pathLower
                        ? dropboxFolderFileCount({
                            folderPathLower: info.pathLower,
                            sources,
                          })
                        : null;
                    return (
                      <li
                        className="flex items-center gap-3 px-3 py-2"
                        key={item.id}
                      >
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">
                            {name}
                          </p>
                          {missing ? (
                            <Badge
                              className="mt-0.5 h-4 px-1.5 text-[10px]"
                              variant="destructive"
                            >
                              {t("connectors.dropbox.folderMissing")}
                            </Badge>
                          ) : count !== null ? (
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {t("connectors.dropbox.folderIndexedCount", {
                                count,
                              })}
                            </p>
                          ) : null}
                        </div>
                        {removeButton(item.id, name)}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            {files.length > 0 ? (
              <section aria-label={t("connectors.dropbox.filesGroup")}>
                <p className="bg-muted/40 px-3 py-1 text-[10px] font-medium text-muted-foreground">
                  {t("connectors.dropbox.filesGroup")}
                </p>
                <ul className="divide-y">
                  {files.map((item) => {
                    const externalId = dropboxExternalId(item.id);
                    const source = sourceByExternalId.get(externalId) ?? null;
                    const state = dropboxItemState({
                      fileId: item.id,
                      source,
                      latestRun,
                      selectionChangedAt,
                    });
                    const name =
                      source?.title?.trim() ||
                      skippedTitleByExternalId.get(externalId) ||
                      described.get(item.id)?.name?.trim() ||
                      item.id;
                    const detail =
                      state.kind === "skipped"
                        ? t(dropboxSkipReasonKey(state.reason))
                        : null;
                    return (
                      <li
                        className="flex items-center gap-3 px-3 py-2"
                        key={item.id}
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">
                            {name}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Badge
                              className="h-4 px-1.5 text-[10px]"
                              variant={stateBadgeVariant(state.kind)}
                            >
                              {t(`connectors.dropbox.state.${state.kind}`)}
                            </Badge>
                            {detail ? (
                              <span className="text-[10px] text-muted-foreground">
                                {detail}
                              </span>
                            ) : null}
                            {source?.indexedAt ? (
                              <span className="text-[10px] text-muted-foreground">
                                {t("connectors.dropbox.lastSynced", {
                                  date: formatDisplayDate(
                                    new Date(source.indexedAt),
                                    displayLocale,
                                  ),
                                })}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        {removeButton(item.id, name)}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>

      <DropboxBrowser
        connectorId={connectorId}
        initialSelection={items}
        onConfirm={handleConfirm}
        onOpenChange={setBrowserOpen}
        open={browserOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}

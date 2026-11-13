import { formatDisplayDate } from "@/lib/i18n/format";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLocale as useDisplayLocale, useTranslations } from "next-intl";

import type { ConnectorActivityItem } from "@sourceweft/sdk";
import { HttpClientError } from "@sourceweft/sdk";
import { readConnectorSkippedItems } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";

import { connectorsClient, contentClient } from "../../../../../../lib/sdk";
import { openGoogleDrivePicker } from "./google-drive-picker";
import {
  GOOGLE_DRIVE_MAX_FILES,
  googleDriveExternalId,
  googleDriveFileName,
  googleDriveFileState,
  googleDrivePickerErrorKey,
  googleDriveSkipReasonKey,
  mergeGoogleDriveSelection,
  parseGoogleDriveFileIds,
  removeGoogleDriveFile,
  type GoogleDriveFileState,
} from "./google-drive-selection";
import type { ConnectorItem } from "./types";

type SourceRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

function stateBadgeVariant(kind: GoogleDriveFileState["kind"]): BadgeVariant {
  if (kind === "failed" || kind === "skipped") return "destructive";
  if (kind === "indexed") return "secondary";
  return "outline";
}

export function GoogleDriveFiles({
  connector,
  latestSyncRun,
  disabled,
  onChangeFileIds,
}: {
  connector: ConnectorItem;
  latestSyncRun: ConnectorActivityItem | null;
  disabled: boolean;
  onChangeFileIds: (fileIds: string[]) => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const displayLocale = useDisplayLocale();
  const workspaceId = connector.raw.workspaceId;
  const connectorId = connector.id;

  const fileIds = parseGoogleDriveFileIds(connector.raw.configJson);
  const fileIdsKey = fileIds.join(",");

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [pickerBusy, setPickerBusy] = useState(false);
  // When this session last submitted an add or remove. Feeds the "unavailable"
  // vs "waiting" decision so a just-added file is not reported as deleted while
  // the activity list still shows the previous successful run. A timestamp, not
  // sensitive; reset when the connector changes.
  const [selectionChangedAt, setSelectionChangedAt] = useState<Date | null>(
    null,
  );

  const latestRunId = latestSyncRun?.id ?? null;
  const latestRunStatus = latestSyncRun?.status ?? null;

  useEffect(() => {
    setSelectionChangedAt(null);
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
    // (indexed / processing) reflect the latest sync.
  }, [workspaceId, connectorId, fileIdsKey, latestRunId, latestRunStatus]);

  const sourceByExternalId = new Map<string, SourceRecord>();
  for (const source of sources) {
    if (source.externalId) {
      sourceByExternalId.set(source.externalId, source);
    }
  }

  const skippedItems = readConnectorSkippedItems(latestSyncRun?.resultJson);
  const latestRun = latestSyncRun
    ? {
        status: latestSyncRun.status,
        // The activity item carries the run's start (`startedAt`); fall back to
        // its creation time for a run that was recorded but not yet started.
        startedAt: new Date(latestSyncRun.startedAt ?? latestSyncRun.createdAt),
        skippedItems,
      }
    : null;

  const handleAddFiles = useCallback(async () => {
    setPickerBusy(true);
    try {
      // A fresh session (and token) is minted on every click; the token is only
      // ever passed into the picker as an argument, never stored.
      const session = await connectorsClient.createGoogleDrivePickerSession(
        workspaceId,
        connectorId,
      );
      const picked = await openGoogleDrivePicker(session);
      if (picked.length === 0) {
        return;
      }
      const current = parseGoogleDriveFileIds(connector.raw.configJson);
      const result = mergeGoogleDriveSelection(current, picked);
      if (!result.ok) {
        toast.error(
          t("connectors.googleDrive.limitReached", { limit: result.limit }),
        );
        return;
      }
      if (result.added === 0) {
        return;
      }
      if (await onChangeFileIds(result.fileIds)) {
        setSelectionChangedAt(new Date());
      }
    } catch (error) {
      const code = error instanceof HttpClientError ? error.code : undefined;
      toast.error(t(googleDrivePickerErrorKey(code)));
    } finally {
      setPickerBusy(false);
    }
  }, [workspaceId, connectorId, connector.raw.configJson, onChangeFileIds, t]);

  const handleRemove = useCallback(
    async (fileId: string) => {
      const current = parseGoogleDriveFileIds(connector.raw.configJson);
      if (await onChangeFileIds(removeGoogleDriveFile(current, fileId))) {
        setSelectionChangedAt(new Date());
      }
    },
    [connector.raw.configJson, onChangeFileIds],
  );

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("connectors.googleDrive.filesTitle")}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            {t("connectors.googleDrive.filesDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {t("connectors.googleDrive.count", {
              count: fileIds.length,
              limit: GOOGLE_DRIVE_MAX_FILES,
            })}
          </span>
          <Button
            disabled={disabled || pickerBusy}
            onClick={handleAddFiles}
            size="xs"
            type="button"
            variant="outline"
          >
            {pickerBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {t("connectors.googleDrive.addFiles")}
          </Button>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-md border">
        {isLoadingSources && fileIds.length > 0 ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : fileIds.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t("connectors.googleDrive.empty")}
          </p>
        ) : (
          <ul className="max-h-64 divide-y overflow-y-auto">
            {fileIds.map((fileId) => {
              const source =
                sourceByExternalId.get(googleDriveExternalId(fileId)) ?? null;
              const state = googleDriveFileState({
                fileId,
                source,
                latestRun,
                selectionChangedAt,
              });
              const name = googleDriveFileName({
                fileId,
                source,
                skippedItems,
              });
              const removeLabel = t("connectors.googleDrive.remove", { name });
              const detail =
                state.kind === "skipped"
                  ? t(googleDriveSkipReasonKey(state.reason))
                  : null;
              return (
                <li
                  className="flex items-center gap-3 px-3 py-2"
                  key={fileId}
                >
                  <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge
                        className="h-4 px-1.5 text-[10px]"
                        variant={stateBadgeVariant(state.kind)}
                      >
                        {t(`connectors.googleDrive.state.${state.kind}`)}
                      </Badge>
                      {detail ? (
                        <span className="text-[10px] text-muted-foreground">
                          {detail}
                        </span>
                      ) : null}
                      {source?.indexedAt ? (
                        <span className="text-[10px] text-muted-foreground">
                          {t("connectors.googleDrive.lastSynced", {
                            date: formatDisplayDate(
                              new Date(source.indexedAt),
                              displayLocale,
                            ),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    className="size-7 shrink-0"
                    disabled={disabled}
                    onClick={() => void handleRemove(fileId)}
                    size="icon-xs"
                    title={removeLabel}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">{removeLabel}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

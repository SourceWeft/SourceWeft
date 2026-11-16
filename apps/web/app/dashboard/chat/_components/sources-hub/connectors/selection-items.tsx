import { formatDisplayDate } from "@/lib/i18n/format";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLocale as useDisplayLocale, useTranslations } from "next-intl";

import type {
  ConnectorActivityItem,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionItem,
  ConnectorSelectionSpec,
} from "@sourceweft/sdk";
import { readConnectorSkippedItems } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";

import { connectorsClient, contentClient } from "../../../../../../lib/sdk";
import { getConnectorProviderName } from "./components";
import {
  connectorFileState,
  type ConnectorFileState,
} from "./connector-file-state";
import { SelectionBrowser } from "./selection-browser";
import {
  mergeSelection,
  readSelection,
  removeSelectionItem,
  selectionSkipReasonKey,
} from "./selection";
import { byTypeOrDefault, displayName, kindHeading } from "./selection-copy";
import {
  selectionIconFor,
  selectionPresenterFor,
} from "./selection-presenters";
import type { ConnectorItem } from "./types";

type SourceRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** A selection describe call accepts at most this many ids. */
const DESCRIBE_CHUNK_SIZE = 100;

function stateBadgeVariant(kind: ConnectorFileState["kind"]): BadgeVariant {
  if (kind === "failed" || kind === "skipped") return "destructive";
  if (kind === "indexed") return "secondary";
  return "outline";
}

/** What `selectionDescribe` said about an id; `null` when it answered without
 * that id. */
type DescribedById = ReadonlyMap<string, ConnectorSelectionDescribeItem | null>;

function chunk(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += DESCRIBE_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + DESCRIBE_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * A connector's selected items in its settings. Generic over the connector's
 * selection spec and presenter (R7).
 *
 * A connector whose presenter declares `indexing` (Dropbox) behaves as the
 * Dropbox list did: rows carry an index state, folder rows count their
 * indexed files, and only containers and files no connector source names are
 * described. A connector without `indexing` (tools-only) loads no sources and
 * describes every selected id, showing each item's name, detail and a "no
 * longer exists" mark, with no state badge.
 */
export function SelectionItems({
  connector,
  spec,
  latestSyncRun,
  disabled,
  onChangeItems,
}: {
  connector: ConnectorItem;
  spec: ConnectorSelectionSpec;
  latestSyncRun: ConnectorActivityItem | null;
  disabled: boolean;
  onChangeItems: (items: ConnectorSelectionItem[]) => Promise<boolean>;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const displayLocale = useDisplayLocale();
  const workspaceId = connector.raw.workspaceId;
  const connectorId = connector.id;
  const connectorType = connector.raw.connectorType;
  const providerName = getConnectorProviderName(connectorType);
  const presenter = selectionPresenterFor(connectorType);
  const indexing = presenter.indexing;

  const items = readSelection(connector.raw.configJson, spec);
  const itemsKey = items.map((item) => `${item.kind}:${item.id}`).join(",");
  // With indexing, a "container" is an item that maps to no source (its
  // `externalIdFor` is null); the rest are files with their own source.
  const containers = indexing
    ? items.filter((item) => indexing.externalIdFor(item) === null)
    : [];
  const files = indexing
    ? items.filter((item) => indexing.externalIdFor(item) !== null)
    : [];

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(Boolean(indexing));
  // Describe answers cached across source reloads, so a sync advancing does
  // not describe the same containers again. Reset when the connector changes.
  const [described, setDescribed] = useState<DescribedById>(() => new Map());
  // False until the first describe settles, so rows wait for names instead of
  // flashing raw ids.
  const [describeSettled, setDescribeSettled] = useState(false);
  // Ids already asked about in this generation (in flight, answered or
  // failed), so a re-render never asks twice. A failed id is retried only when
  // the section mounts again (the settings reopen) or the connector changes.
  const askedRef = useRef(new Set<string>());
  // Bumped on connector change and unmount; a describe answer from an older
  // generation is dropped.
  const describeGenerationRef = useRef(0);
  const [browserOpen, setBrowserOpen] = useState(false);
  // When this session last submitted an add or remove. Feeds the "unavailable"
  // vs "waiting" decision. Reset when the connector changes.
  const [selectionChangedAt, setSelectionChangedAt] = useState<Date | null>(
    null,
  );

  const latestRunId = latestSyncRun?.id ?? null;
  const latestRunStatus = latestSyncRun?.status ?? null;

  useEffect(() => {
    setSelectionChangedAt(null);
    setDescribed(new Map());
    setDescribeSettled(false);
    askedRef.current = new Set();
    describeGenerationRef.current += 1;
    return () => {
      describeGenerationRef.current += 1;
    };
  }, [connectorId]);

  useEffect(() => {
    if (!indexing) {
      setIsLoadingSources(false);
      return;
    }
    let active = true;
    setIsLoadingSources(true);
    contentClient
      .listSources(workspaceId, { connectorId, includeContent: false })
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
    // (indexed / processing) and container counts reflect the latest sync.
  }, [
    indexing,
    workspaceId,
    connectorId,
    itemsKey,
    latestRunId,
    latestRunStatus,
  ]);

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

  // Which ids still need a describe. Tools-only: every selected id. Indexing:
  // every container, plus a file only when neither its source nor a skipped
  // item names it (known once the sources load). Ids already described are
  // not asked again.
  const fileNeedsDescribe = (item: ConnectorSelectionItem) => {
    if (!indexing) return false;
    const externalId = indexing.externalIdFor(item);
    if (externalId === null) return false;
    return (
      !sourceByExternalId.get(externalId)?.title?.trim() &&
      !skippedTitleByExternalId.has(externalId)
    );
  };
  const describeIds = (
    indexing
      ? [
          ...containers.map((item) => item.id),
          ...(isLoadingSources
            ? []
            : files.filter(fileNeedsDescribe).map((item) => item.id)),
        ]
      : items.map((item) => item.id)
  ).filter((id) => !described.has(id));
  const describeKey = describeIds.join(",");

  useEffect(() => {
    if (!describeKey) return;
    const idsToDescribe = describeKey
      .split(",")
      .filter((id) => !askedRef.current.has(id));
    if (idsToDescribe.length === 0) return;
    const generation = describeGenerationRef.current;
    const isCurrent = () => generation === describeGenerationRef.current;
    for (const id of idsToDescribe) askedRef.current.add(id);
    void (async () => {
      // One chunk at a time: the backend looks up each id separately, so
      // parallel chunks would multiply the concurrent provider calls.
      for (const ids of chunk(idsToDescribe)) {
        try {
          const result = await connectorsClient.selectionDescribe(
            workspaceId,
            connectorId,
            { ids },
          );
          if (!isCurrent()) return;
          const byId = new Map(result.items.map((item) => [item.id, item]));
          setDescribed((current) => {
            const next = new Map(current);
            for (const id of ids) next.set(id, byId.get(id) ?? null);
            return next;
          });
        } catch {
          // Keep what is already known; these rows fall back to ids.
        }
      }
      if (isCurrent()) setDescribeSettled(true);
    })();
  }, [workspaceId, connectorId, describeKey]);

  const awaitingNames = describeKey !== "" && !describeSettled;
  const isLoading = (isLoadingSources || awaitingNames) && items.length > 0;

  const handleConfirm = useCallback(
    async (picked: ConnectorSelectionItem[]) => {
      const current = readSelection(connector.raw.configJson, spec);
      const result = mergeSelection(current, picked, spec.maxItems);
      if (!result.ok) {
        toast.error(
          t("connectors.selection.limitReached", { limit: result.limit }),
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
    [connector.raw.configJson, onChangeItems, spec, t],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const current = readSelection(connector.raw.configJson, spec);
      if (await onChangeItems(removeSelectionItem(current, id))) {
        setSelectionChangedAt(new Date());
      }
    },
    [connector.raw.configJson, onChangeItems, spec],
  );

  function removeButton(id: string, name: string) {
    const label = t("connectors.selection.remove", { name });
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

  function renderItemRow(item: ConnectorSelectionItem) {
    const info = described.get(item.id) ?? null;
    const missing = info?.exists === false;
    const Icon = selectionIconFor(presenter, item.kind, false);

    if (indexing) {
      const externalId = indexing.externalIdFor(item);
      if (externalId === null) {
        // Container row: name and the count of its indexed sources.
        const name = displayName(t, info?.name, item.id);
        const count = missing
          ? null
          : indexing.containerIndexedCount({ item, described: info, sources });
        return (
          <li className="flex items-center gap-3 px-3 py-2" key={item.id}>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {name}
              </p>
              {missing ? (
                <Badge
                  className="mt-0.5 h-4 px-1.5 text-[10px]"
                  variant="destructive"
                >
                  {t("connectors.selection.missing")}
                </Badge>
              ) : count !== null ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("connectors.selection.containerIndexedCount", { count })}
                </p>
              ) : null}
            </div>
            {removeButton(item.id, name)}
          </li>
        );
      }
      // File row: its index state, skip reason and last sync time.
      const source = sourceByExternalId.get(externalId) ?? null;
      const state = connectorFileState({
        externalId,
        source,
        latestRun,
        selectionChangedAt,
      });
      const name = displayName(
        t,
        source?.title?.trim() ||
          skippedTitleByExternalId.get(externalId) ||
          info?.name,
        item.id,
      );
      const detail =
        state.kind === "skipped" ? t(selectionSkipReasonKey(state.reason)) : null;
      return (
        <li className="flex items-center gap-3 px-3 py-2" key={item.id}>
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {name}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge
                className="h-4 px-1.5 text-[10px]"
                variant={stateBadgeVariant(state.kind)}
              >
                {t(`connectors.selection.state.${state.kind}`, {
                  provider: providerName,
                })}
              </Badge>
              {detail ? (
                <span className="text-[10px] text-muted-foreground">
                  {detail}
                </span>
              ) : null}
              {source?.indexedAt ? (
                <span className="text-[10px] text-muted-foreground">
                  {t("connectors.selection.lastSynced", {
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
    }

    // Tools-only row: name, detail and the "no longer exists" mark only.
    const name = displayName(t, info?.name, item.id);
    const detail = info?.detail?.trim() || null;
    return (
      <li className="flex items-center gap-3 px-3 py-2" key={item.id}>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{name}</p>
          {missing ? (
            <Badge
              className="mt-0.5 h-4 px-1.5 text-[10px]"
              variant="destructive"
            >
              {t("connectors.selection.missing")}
            </Badge>
          ) : detail ? (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
        {removeButton(item.id, name)}
      </li>
    );
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {byTypeOrDefault(t, connectorType, "itemsTitle")}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            {byTypeOrDefault(t, connectorType, "itemsDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {t("connectors.selection.count", {
              count: items.length,
              limit: spec.maxItems,
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
            {byTypeOrDefault(t, connectorType, "choose")}
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
            {byTypeOrDefault(t, connectorType, "empty")}
          </p>
        ) : (
          <div className="max-h-72 divide-y overflow-y-auto">
            {spec.kinds.map((kind) => {
              const kindItems = items.filter((item) => item.kind === kind);
              if (kindItems.length === 0) return null;
              const heading = kindHeading(t, connectorType, kind);
              return (
                <section aria-label={heading} key={kind}>
                  <p className="bg-muted/40 px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {heading}
                  </p>
                  <ul className="divide-y">{kindItems.map(renderItemRow)}</ul>
                </section>
              );
            })}
          </div>
        )}
      </div>

      <SelectionBrowser
        connectorId={connectorId}
        connectorType={connectorType}
        initialSelection={items}
        onConfirm={handleConfirm}
        onOpenChange={setBrowserOpen}
        open={browserOpen}
        providerName={providerName}
        spec={spec}
        workspaceId={workspaceId}
      />
    </div>
  );
}

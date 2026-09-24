import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
import { Clock3, Loader2, RotateCcw, Sparkles, Webhook } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ConnectorActivityItem } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { HubEmptyState } from "../components/hub-empty-state";
import { formatDuration, formatJsonPreview } from "../lib/format";
import type { ConnectorActivityKindFilter } from "./types";

/** Translator handed to the module-level activity formatters. */
type ActivityT = ReturnType<typeof useTranslations>;

function activityTone(status: string) {
  if (status === "succeeded" || status === "processed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "running" || status === "queued" || status === "received") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (status === "blocked") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (status === "skipped" || status === "ignored") {
    return "border-border bg-muted/50 text-muted-foreground";
  }
  if (status === "failed" || status === "error") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted/50 text-muted-foreground";
}

function ActivityStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={cn("h-5 border px-1.5 text-[10px]", activityTone(status))}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

// Known summary keys carry a localized label under
// `connectorActivity.summary.<key>`; any other key falls back to its raw name.
const knownConnectorActivitySummaryKeys = new Set<string>([
  "actionType",
  "attempts",
  "discoveredCount",
  "eventType",
  "externalId",
  "failedCount",
  "fullResync",
  "heartbeatAt",
  "indexedCount",
  "objectId",
  "objectType",
  "oversizedCount",
  "providerEventId",
  "reason",
  "requestPreview",
  "riskLevel",
  "source",
  "targetExternalIds",
  "targetExternalIdCount",
  "targeted",
  "syncRunId",
  "triggerType",
]);

const hiddenConnectorActivitySummaryKeys = new Set([
  "approvedBy",
  "createdBy",
  "executedBy",
]);

function formatConnectorActivityTitle(
  item: ConnectorActivityItem,
  t: ActivityT,
) {
  if (item.kind === "sync") {
    const trigger =
      typeof item.summaryJson.triggerType === "string"
        ? item.summaryJson.triggerType
        : "connector";
    const triggerLabel =
      trigger === "manual" ||
      trigger === "scheduled" ||
      trigger === "webhook" ||
      trigger === "backfill"
        ? t(`connectorActivity.trigger.${trigger}`)
        : trigger;
    return t("connectorActivity.syncTitle", { trigger: triggerLabel });
  }
  if (item.kind === "action") {
    return typeof item.summaryJson.actionType === "string"
      ? item.summaryJson.actionType
      : t("connectorActivity.connectorAction");
  }
  if (item.kind === "webhook") {
    return typeof item.summaryJson.eventType === "string"
      ? item.summaryJson.eventType
      : t("connectorActivity.webhookEvent");
  }
  return item.title;
}

function formatConnectorActivityValue(
  value: unknown,
  t: ActivityT,
  displayLocale: string,
) {
  if (typeof value === "boolean") {
    return value ? t("connectorActivity.yes") : t("connectorActivity.no");
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(date.getTime())) {
      return formatDisplayDate(date, displayLocale);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : t("connectorActivity.none");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function ActivityRow({ item }: { item: ConnectorActivityItem }) {
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSourcesHub");
  const Icon =
    item.kind === "sync"
      ? RotateCcw
      : item.kind === "action"
        ? Sparkles
        : Webhook;
  const summaryEntries = Object.entries(item.summaryJson)
    .filter(
      ([key, value]) =>
        !hiddenConnectorActivitySummaryKeys.has(key) &&
        value !== null &&
        value !== undefined,
    )
    .slice(0, 6);
  return (
    <div className="rounded-lg border bg-background p-2.5 text-xs">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/25">
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {formatConnectorActivityTitle(item, t)}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {formatDisplayDate(new Date(item.createdAt), displayLocale)} ·{" "}
                {formatDuration(item.durationMs)}
              </p>
            </div>
            <ActivityStatusBadge status={item.status} />
          </div>
          {summaryEntries.length > 0 ? (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
              {summaryEntries.map(([key, value]) => (
                <div
                  className="min-w-0 rounded-md bg-muted/35 px-2 py-1"
                  key={key}
                >
                  <span className="block text-[10px] text-muted-foreground">
                    {knownConnectorActivitySummaryKeys.has(key)
                      ? t(`connectorActivity.summary.${key}`)
                      : key}
                  </span>
                  <span className="block truncate text-[11px] text-foreground">
                    {formatConnectorActivityValue(value, t, displayLocale)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {item.errorMessage ? (
            item.status === "blocked" ? (
              <Alert className="mt-2 border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                <AlertDescription className="text-inherit">
                  {item.errorMessage}
                </AlertDescription>
              </Alert>
            ) : (
              <Alert className="mt-2" variant="destructive">
                <AlertDescription>{item.errorMessage}</AlertDescription>
              </Alert>
            )
          ) : null}
          {Object.keys(item.resultJson).length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                {t("connectorActivity.executionResult")}
              </summary>
              <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-muted/45 p-2 text-[10px] leading-4 text-muted-foreground">
                {formatJsonPreview(item.resultJson)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ActivityList({
  description,
  emptyTitle,
  items,
  kind,
  loading,
  loadingError,
}: {
  description: string;
  emptyTitle: string;
  items: ConnectorActivityItem[];
  kind: ConnectorActivityKindFilter;
  loading: boolean;
  loadingError: string | null;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const filtered =
    kind === "all" ? items : items.filter((item) => item.kind === kind);
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border bg-muted/20 py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          {t("connectorActivity.loading")}
        </div>
      ) : null}
      {loadingError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadingError}</AlertDescription>
        </Alert>
      ) : null}
      {!loading && !loadingError && filtered.length === 0 ? (
        <HubEmptyState
          description={t("connectorActivity.emptyDescription")}
          icon={Clock3}
          title={emptyTitle}
        />
      ) : null}
      {filtered.map((item) => (
        <ActivityRow item={item} key={`${item.kind}:${item.id}`} />
      ))}
    </div>
  );
}

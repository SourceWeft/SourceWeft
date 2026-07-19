import { Clock3, Loader2, RotateCcw, Sparkles, Webhook } from "lucide-react";

import type { ConnectorActivityItem } from "@sourceweft/sdk";
import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { HubEmptyState } from "../components/hub-empty-state";
import { formatDuration, formatJsonPreview } from "../lib/format";
import type { ConnectorActivityKindFilter } from "./types";

function activityTone(status: string) {
  if (status === "succeeded" || status === "processed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "running" || status === "queued" || status === "received") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
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

const connectorActivitySummaryLabels: Record<string, string> = {
  actionType: "Action",
  attempts: "Attempts",
  discoveredCount: "Discovered",
  eventType: "Event",
  externalId: "External ID",
  failedCount: "Failed",
  fullResync: "Full resync",
  heartbeatAt: "Heartbeat",
  indexedCount: "Indexed",
  objectId: "Object ID",
  objectType: "Object",
  providerEventId: "Provider event",
  reason: "Reason",
  requestPreview: "Request",
  riskLevel: "Risk",
  source: "Source",
  targetExternalIds: "Targets",
  targetExternalIdCount: "Target count",
  targeted: "Targeted",
  syncRunId: "Linked sync",
  triggerType: "Trigger",
};

const hiddenConnectorActivitySummaryKeys = new Set([
  "approvedBy",
  "createdBy",
  "executedBy",
]);

function formatConnectorActivityTitle(item: ConnectorActivityItem) {
  if (item.kind === "sync") {
    const trigger =
      typeof item.summaryJson.triggerType === "string"
        ? item.summaryJson.triggerType
        : "connector";
    const triggerLabel =
      trigger === "manual"
        ? "Manual"
        : trigger === "scheduled"
          ? "Scheduled"
          : trigger === "webhook"
            ? "Webhook"
            : trigger === "backfill"
              ? "Backfill"
              : trigger;
    return `${triggerLabel} sync`;
  }
  if (item.kind === "action") {
    return typeof item.summaryJson.actionType === "string"
      ? item.summaryJson.actionType
      : "Connector action";
  }
  if (item.kind === "webhook") {
    return typeof item.summaryJson.eventType === "string"
      ? item.summaryJson.eventType
      : "Webhook event";
  }
  return item.title;
}

function formatConnectorActivityValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(date.getTime())) {
      return date.toLocaleString();
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "None";
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function ActivityRow({ item }: { item: ConnectorActivityItem }) {
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
                {formatConnectorActivityTitle(item)}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {new Date(item.createdAt).toLocaleString()} ·{" "}
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
                    {connectorActivitySummaryLabels[key] ?? key}
                  </span>
                  <span className="block truncate text-[11px] text-foreground">
                    {formatConnectorActivityValue(value)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {item.errorMessage ? (
            <Alert className="mt-2" variant="destructive">
              <AlertDescription>{item.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          {Object.keys(item.resultJson).length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                Execution result
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
  const filtered =
    kind === "all" ? items : items.filter((item) => item.kind === kind);
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border bg-muted/20 py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Loading activity...
        </div>
      ) : null}
      {loadingError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadingError}</AlertDescription>
        </Alert>
      ) : null}
      {!loading && !loadingError && filtered.length === 0 ? (
        <HubEmptyState
          description="Connector activity will appear here after syncs, actions, or webhooks run."
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

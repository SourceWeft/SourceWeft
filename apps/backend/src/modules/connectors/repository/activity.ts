/**
 * The connector activity feed: one merged, cursor-paged timeline built by
 * reading sync runs, action runs and webhook events and projecting each into a
 * common item shape. It spans those three entities by design, which is why it
 * lives here rather than in any one of their repositories.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  connectorActionRuns,
  connectorSyncRuns,
  connectorWebhookEvents,
  db,
} from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import { mapActionRun, mapSyncRun, mapWebhookEvent } from "../mappers";
import { redactConnectorSecrets } from "../security";
import type { ConnectorActivityItemRecord } from "../types";

function parseActivityCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.kind === "string" &&
      typeof parsed.id === "string"
    ) {
      const createdAt = new Date(parsed.createdAt);
      if (!Number.isNaN(createdAt.getTime())) {
        return {
          createdAt: parsed.createdAt,
          createdAtMs: createdAt.getTime(),
          kind: parsed.kind,
          id: parsed.id,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function makeActivityCursor(item: ConnectorActivityItemRecord) {
  return Buffer.from(
    JSON.stringify({
      createdAt: item.createdAt,
      kind: item.kind,
      id: item.id,
    }),
    "utf8",
  ).toString("base64url");
}

function dateMs(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function durationMs(startedAt: string | null, finishedAt: string | null) {
  const start = dateMs(startedAt);
  const finish = dateMs(finishedAt);
  if (start === null || finish === null || finish < start) {
    return null;
  }
  return finish - start;
}

function redactedJson(value: Record<string, unknown>) {
  return redactConnectorSecrets(value) as Record<string, unknown>;
}

function isActivityBeforeCursor(
  item: ConnectorActivityItemRecord,
  cursor: ReturnType<typeof parseActivityCursor>,
) {
  if (!cursor) return true;
  const itemMs = dateMs(item.createdAt);
  if (itemMs === null) return false;
  if (itemMs < cursor.createdAtMs) return true;
  if (itemMs > cursor.createdAtMs) return false;
  const itemKey = `${item.kind}:${item.id}`;
  const cursorKey = `${cursor.kind}:${cursor.id}`;
  return itemKey < cursorKey;
}

function toSyncActivityItem(
  run: ReturnType<typeof mapSyncRun>,
): ConnectorActivityItemRecord {
  const summaryJson = {
    triggerType: run.triggerType,
    eventType: run.metadataJson.eventType ?? null,
    discoveredCount: run.discoveredCount,
    indexedCount: run.indexedCount,
    failedCount: run.failedCount,
    heartbeatAt: run.heartbeatAt,
    createdBy: run.createdBy,
    targetExternalIds: run.metadataJson.targetExternalIds ?? null,
    targetExternalIdCount: Array.isArray(run.metadataJson.targetExternalIds)
      ? run.metadataJson.targetExternalIds.length
      : null,
    targeted: run.metadataJson.targeted ?? null,
    fullResync: run.metadataJson.fullResync ?? null,
    reason: run.metadataJson.reason ?? run.metadataJson.readinessReason ?? null,
    providerEventId: run.metadataJson.providerEventId ?? null,
  };
  return {
    id: run.id,
    kind: "sync",
    status: run.status,
    title: `${run.triggerType} sync ${run.status}`,
    summaryJson: redactedJson(summaryJson),
    resultJson: redactedJson(run.metadataJson),
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    linkedRunId: run.id,
    linkedActionId:
      typeof run.metadataJson.actionRunId === "string"
        ? run.metadataJson.actionRunId
        : null,
    linkedWebhookEventId:
      typeof run.metadataJson.webhookEventId === "string"
        ? run.metadataJson.webhookEventId
        : typeof run.metadataJson.eventId === "string"
          ? run.metadataJson.eventId
          : null,
  };
}

function toActionActivityItem(
  action: ReturnType<typeof mapActionRun>,
): ConnectorActivityItemRecord {
  const postActionSyncRunId =
    typeof action.resultJson.postActionSyncRunId === "string"
      ? action.resultJson.postActionSyncRunId
      : null;
  return {
    id: action.id,
    kind: "action",
    status: action.status,
    title: `${action.actionType} ${action.status}`,
    summaryJson: redactedJson({
      actionType: action.actionType,
      riskLevel: action.riskLevel,
      requestPreview: action.requestPreview,
      externalId: action.externalId,
      approvedBy: action.approvedBy,
      executedBy: action.executedBy,
    }),
    resultJson: redactedJson(action.resultJson),
    errorCode: action.errorCode,
    errorMessage: action.errorMessage,
    createdAt: action.createdAt,
    startedAt: action.status === "running" ? action.updatedAt : null,
    finishedAt: ["succeeded", "failed", "canceled", "rejected"].includes(
      action.status,
    )
      ? action.updatedAt
      : null,
    durationMs: null,
    linkedRunId: postActionSyncRunId,
    linkedActionId: action.id,
    linkedWebhookEventId: null,
  };
}

function toWebhookActivityItem(
  event: ReturnType<typeof mapWebhookEvent>,
): ConnectorActivityItemRecord {
  return {
    id: event.id,
    kind: "webhook",
    status: event.status,
    title: `${event.eventType} ${event.status}`,
    summaryJson: redactedJson({
      eventType: event.eventType,
      objectType: event.objectType,
      objectId: event.objectId,
      attempts: event.attempts,
      providerEventId: event.providerEventId,
      syncRunId: event.syncRunId,
    }),
    resultJson: redactedJson(event.payloadMetadataJson),
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    createdAt: event.receivedAt,
    startedAt: event.receivedAt,
    finishedAt: event.processedAt,
    durationMs: durationMs(event.receivedAt, event.processedAt),
    linkedRunId: event.syncRunId,
    linkedActionId: null,
    linkedWebhookEventId: event.id,
  };
}

function connectorActivityQueryFailureItem(input: {
  kind: "sync" | "action" | "webhook";
  error: unknown;
}): ConnectorActivityItemRecord {
  const rawMessage = input.error instanceof Error ? input.error.message : "";
  const missingTable =
    /relation .*connector_webhook_events.* does not exist/i.test(rawMessage) ||
    /connector_webhook_events/i.test(rawMessage);
  const message =
    input.kind === "webhook" && missingTable
      ? "Webhook activity storage is not ready. Run backend migrations through 0025_connector_webhook_events."
      : `Failed to load ${input.kind} activity records. Check backend logs for details.`;
  const errorCode =
    input.kind === "webhook" && missingTable
      ? "CONNECTOR_WEBHOOK_MIGRATION_REQUIRED"
      : "CONNECTOR_ACTIVITY_QUERY_FAILED";
  const now = new Date().toISOString();
  return {
    id: `${input.kind}:activity-query-failed`,
    kind: input.kind,
    status: "failed",
    title: `${input.kind} activity unavailable`,
    summaryJson: {
      source: input.kind,
      reason:
        input.kind === "webhook" && missingTable
          ? "migration_required"
          : "query_failed",
    },
    resultJson: {},
    errorCode,
    errorMessage: message,
    createdAt: now,
    startedAt: null,
    finishedAt: now,
    durationMs: null,
    linkedRunId: null,
    linkedActionId: null,
    linkedWebhookEventId: null,
  };
}

export async function listConnectorActivityRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  kind?: "all" | "sync" | "action" | "webhook";
  limit: number;
  cursor?: string | null;
}) {
  const effectiveKind = input.kind ?? "all";
  const fetchLimit = Math.min(Math.max(input.limit, 1), 100) + 1;
  const items: ConnectorActivityItemRecord[] = [];

  if (effectiveKind === "all" || effectiveKind === "sync") {
    try {
      const rows = await db
        .select()
        .from(connectorSyncRuns)
        .where(
          and(
            eq(connectorSyncRuns.teamId, input.teamId),
            eq(connectorSyncRuns.workspaceId, input.workspaceId),
            eq(connectorSyncRuns.connectorId, input.connectorId),
          ),
        )
        .orderBy(desc(connectorSyncRuns.createdAt))
        .limit(fetchLimit);
      items.push(...rows.map((row) => toSyncActivityItem(mapSyncRun(row))));
    } catch (error) {
      logger.warn("Failed to list connector sync activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "sync", error }));
    }
  }

  if (effectiveKind === "all" || effectiveKind === "action") {
    try {
      const rows = await db
        .select()
        .from(connectorActionRuns)
        .where(
          and(
            eq(connectorActionRuns.teamId, input.teamId),
            eq(connectorActionRuns.workspaceId, input.workspaceId),
            eq(connectorActionRuns.connectorId, input.connectorId),
          ),
        )
        .orderBy(desc(connectorActionRuns.createdAt))
        .limit(fetchLimit);
      items.push(...rows.map((row) => toActionActivityItem(mapActionRun(row))));
    } catch (error) {
      logger.warn("Failed to list connector action activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "action", error }));
    }
  }

  if (effectiveKind === "all" || effectiveKind === "webhook") {
    try {
      const rows = await db
        .select()
        .from(connectorWebhookEvents)
        .where(
          and(
            eq(connectorWebhookEvents.teamId, input.teamId),
            eq(connectorWebhookEvents.workspaceId, input.workspaceId),
            eq(connectorWebhookEvents.connectorId, input.connectorId),
          ),
        )
        .orderBy(desc(connectorWebhookEvents.receivedAt))
        .limit(fetchLimit);
      items.push(
        ...rows.map((row) => toWebhookActivityItem(mapWebhookEvent(row))),
      );
    } catch (error) {
      logger.warn("Failed to list connector webhook activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "webhook", error }));
    }
  }

  const cursor = parseActivityCursor(input.cursor);
  const filtered = items
    .filter((item) => isActivityBeforeCursor(item, cursor))
    .sort((a, b) => {
      const timeDelta = (dateMs(b.createdAt) ?? 0) - (dateMs(a.createdAt) ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return `${b.kind}:${b.id}`.localeCompare(`${a.kind}:${a.id}`);
    });
  const page = filtered.slice(0, input.limit);
  const hasMore = filtered.length > input.limit;
  return {
    items: page,
    nextCursor:
      hasMore && page.length
        ? makeActivityCursor(page[page.length - 1]!)
        : null,
  };
}

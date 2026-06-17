import { createHash } from "node:crypto";
import { ConnectorError, toConnectorError } from "./errors";
import {
  findSourceConnectorRecordById,
  insertWebhookEventRecord,
  listOAuthAccountRecordsByProviderAccount,
  listSourceConnectorRecordsByOAuthAccount,
  listWebhookEventRecords,
  updateSourceConnectorRecord,
  updateWebhookEventRecord,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import { requireConnectorWorkspace } from "./permissions";
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";
import { billingService } from "../billing";
import { enqueueConnectorSyncJob } from "../content/queue";
import {
  findSourceRecordByConnectorExternalId,
  updateSourceRecord,
} from "../sources";
import { logger } from "../../shared/logger";
import type {
  ConnectorWebhookPayload,
  ConnectorWebhookTarget,
  SourceConnectorRecord,
} from "./types";

function headersToRecord(headers: Headers) {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
}

function fallbackEventId(input: {
  connectorType: string;
  rawBody: string;
  eventType?: string;
}) {
  const hash = createHash("sha256")
    .update(input.connectorType)
    .update("\n")
    .update(input.eventType ?? "")
    .update("\n")
    .update(input.rawBody)
    .digest("hex");
  return `fallback:${hash}`;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function hasTargetedSync(targets: ConnectorWebhookTarget[]) {
  return targets.some(
    (target) => target.action === "sync" && Boolean(target.externalId),
  );
}

function buildExternalId(target: ConnectorWebhookTarget) {
  if (target.externalId) {
    return target.externalId;
  }
  if (target.objectType && target.objectId) {
    return `${target.objectType}:${target.objectId}`;
  }
  return null;
}

export class ConnectorWebhookService {
  constructor(
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly syncOrchestrator = new ConnectorSyncOrchestrator(
      billingService,
      registry,
    ),
  ) {}

  async receive(input: {
    connectorType: string;
    request: Request;
    query: Record<string, string | undefined>;
  }) {
    const adapter = this.registry.getAdapter(input.connectorType);
    if (!adapter.parseWebhookEvent) {
      throw new ConnectorError(
        400,
        "CONNECTOR_WEBHOOK_NOT_SUPPORTED",
        "Connector webhook is not supported",
      );
    }

    const rawBody = await input.request.text();
    const verifyInput = {
      headers: headersToRecord(input.request.headers),
      rawBody,
      query: input.query,
    };
    if (adapter.verifyWebhook) {
      await adapter.verifyWebhook(verifyInput);
    }

    const parsed = await adapter.parseWebhookEvent(verifyInput);
    const event: ConnectorWebhookPayload = {
      ...parsed,
      providerEventId:
        parsed.providerEventId ||
        fallbackEventId({
          connectorType: input.connectorType,
          rawBody,
          eventType: parsed.eventType,
        }),
    };
    const connectors = await this.resolveConnectors({
      connectorType: input.connectorType,
      event,
      connectorId: input.query.connectorId || event.connectorId || null,
    });
    const primaryConnector = connectors[0] ?? null;

    const webhookEvent = await insertWebhookEventRecord({
      teamId: primaryConnector?.teamId ?? null,
      workspaceId: primaryConnector?.workspaceId ?? null,
      connectorId: primaryConnector?.id ?? null,
      connectorType: input.connectorType,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      status: "received",
      objectId: event.objectId,
      objectType: event.objectType,
      payloadMetadataJson: event.metadata,
    });

    if (webhookEvent.status === "processed" || webhookEvent.status === "queued") {
      return { event: webhookEvent, duplicate: true };
    }

    await updateWebhookEventRecord({
      webhookEventId: webhookEvent.id,
      attemptsDelta: 1,
    });

    try {
      if (connectors.length === 0) {
        const ignored = await updateWebhookEventRecord({
          webhookEventId: webhookEvent.id,
          status: "ignored",
          errorCode: "CONNECTOR_WEBHOOK_TARGET_NOT_FOUND",
          errorMessage: "No active connector matched the webhook event",
          processedAt: new Date(),
        });
        return { event: ignored ?? webhookEvent, duplicate: false };
      }

      const targets = adapter.mapWebhookEventToSyncTargets
        ? await adapter.mapWebhookEventToSyncTargets(event)
        : [];
      const meaningfulTargets =
        targets.length > 0
          ? targets
          : [{ action: "record_only" as const, reason: "no targets" }];

      const syncRunIds: string[] = [];
      for (const connector of connectors) {
        const shouldFullResync = meaningfulTargets.some(
          (target) => target.action === "sync",
        ) && !hasTargetedSync(meaningfulTargets);
        const syncExternalIds = uniqueStrings(
          meaningfulTargets
            .filter((target) => target.action === "sync")
            .map((target) => target.externalId),
        );
        const archiveExternalIds = uniqueStrings(
          meaningfulTargets
            .filter((target) => target.action === "archive_source")
            .map(buildExternalId),
        );

        for (const externalId of archiveExternalIds) {
          await this.archiveConnectorSource({
            connector,
            externalId,
            event,
          });
        }

        if (syncExternalIds.length > 0 || shouldFullResync) {
          const run = await this.syncOrchestrator.createWebhookRun({
            teamId: connector.teamId,
            workspaceId: connector.workspaceId,
            connectorId: connector.id,
            metadataJson: {
              eventId: webhookEvent.id,
              providerEventId: event.providerEventId,
              eventType: event.eventType,
              providerObjectId: event.objectId,
              targetExternalIds: syncExternalIds,
              targeted: syncExternalIds.length > 0,
              fullResync: shouldFullResync,
            },
          });
          syncRunIds.push(run.id);
          await enqueueConnectorSyncJob({
            runId: run.id,
            teamId: connector.teamId,
            workspaceId: connector.workspaceId,
            connectorId: connector.id,
            userId: connector.createdBy ?? "system",
            targetExternalIds: syncExternalIds.length
              ? syncExternalIds
              : undefined,
          });
        }
      }

      const finalStatus = syncRunIds.length > 0 ? "queued" : "processed";
      const updated = await updateWebhookEventRecord({
        webhookEventId: webhookEvent.id,
        status: finalStatus,
        syncRunId: syncRunIds[0] ?? null,
        payloadMetadataJson: {
          ...event.metadata,
          targetCount: meaningfulTargets.length,
          syncRunIds,
        },
        processedAt: finalStatus === "processed" ? new Date() : null,
      });
      return { event: updated ?? webhookEvent, duplicate: false };
    } catch (error) {
      const connectorError = toConnectorError(error);
      const failed = await updateWebhookEventRecord({
        webhookEventId: webhookEvent.id,
        status: "failed",
        errorCode: connectorError.code,
        errorMessage: connectorError.message,
      });
      return { event: failed ?? webhookEvent, duplicate: false };
    }
  }

  async list(input: {
    workspaceId: string;
    userId: string;
    connectorType?: string;
    connectorId?: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    try {
      const items = await listWebhookEventRecords({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorType: input.connectorType,
        connectorId: input.connectorId,
      });
      return { items };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      if (
        /relation .*connector_webhook_events.* does not exist/i.test(rawMessage) ||
        /connector_webhook_events/i.test(rawMessage)
      ) {
        logger.warn("Connector webhook event storage is not ready", {
          error,
          workspaceId: workspace.id,
          connectorId: input.connectorId,
        });
        return { items: [] };
      }
      throw error;
    }
  }

  private async resolveConnectors(input: {
    connectorType: string;
    event: ConnectorWebhookPayload;
    connectorId?: string | null;
  }) {
    if (input.connectorId) {
      const connector = await findSourceConnectorRecordById({
        connectorId: input.connectorId,
      });
      return connector &&
        connector.connectorType === input.connectorType &&
        connector.status !== "disabled"
        ? [connector]
        : [];
    }

    const workspaceHint = input.event.workspaceHint?.trim();
    if (!workspaceHint) {
      return [];
    }
    const accounts = await listOAuthAccountRecordsByProviderAccount({
      connectorType: input.connectorType,
      providerAccountId: workspaceHint,
    });
    const connectorGroups = await Promise.all(
      accounts.map((account) =>
        listSourceConnectorRecordsByOAuthAccount({
          connectorType: input.connectorType,
          oauthAccountId: account.id,
        }),
      ),
    );
    return connectorGroups.flat();
  }

  private async archiveConnectorSource(input: {
    connector: SourceConnectorRecord;
    externalId: string;
    event: ConnectorWebhookPayload;
  }) {
    const source = await findSourceRecordByConnectorExternalId({
      teamId: input.connector.teamId,
      workspaceId: input.connector.workspaceId,
      connectorId: input.connector.id,
      externalId: input.externalId,
    });
    if (!source) {
      return;
    }
    await updateSourceRecord({
      teamId: input.connector.teamId,
      workspaceId: input.connector.workspaceId,
      sourceId: source.id,
      status: "archived",
      metadata: {
        ...source.metadata,
        lastWebhookEvent: {
          providerEventId: input.event.providerEventId,
          eventType: input.event.eventType,
          objectId: input.event.objectId,
        },
      },
    });
    await updateSourceConnectorRecord({
      teamId: input.connector.teamId,
      workspaceId: input.connector.workspaceId,
      connectorId: input.connector.id,
      lastIndexedAt: new Date(),
      lastError: null,
    });
  }
}

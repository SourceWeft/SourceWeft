import { createHash } from "node:crypto";
import type { ContentBillingPort } from "../content/billing-port";
import { SourceIndexingService } from "../content/sources";
import {
  createSourceRecord,
  createSourceRevisionRecord,
  findSourceRecordByConnectorExternalId,
  updateSourceRecord,
} from "../content/sources/repository";
import { ConnectorError, toConnectorError } from "./errors";
import { requireConnectorWorkspace } from "./permissions";
import {
  createSyncRunRecord,
  findSourceConnectorRecord,
  findSyncRunRecord,
  incrementSyncRunCounts,
  listSyncRunRecords,
  touchConnectorScheduleAfterSync,
  updateSyncRunRecord,
} from "./repository";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type { ConnectorItem, ConnectorSyncRunTriggerType } from "./types";

function computeContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSourceTitle(title: string) {
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 200) : "Connector Source";
}

function asErrorSummary(error: unknown) {
  const connectorError = toConnectorError(error);
  return {
    code: connectorError.code,
    message: connectorError.message,
  };
}

function shouldSkipExtract(input: {
  existing: Awaited<ReturnType<typeof findSourceRecordByConnectorExternalId>>;
  item: ConnectorItem;
}) {
  if (!input.existing) {
    return false;
  }
  if (input.item.contentHash && input.existing.contentHash === input.item.contentHash) {
    return true;
  }
  if (
    !input.item.contentHash &&
    input.item.externalUpdatedAt &&
    input.existing.externalUpdatedAt === input.item.externalUpdatedAt.toISOString()
  ) {
    return true;
  }
  return false;
}

export class ConnectorSyncOrchestrator {
  private readonly indexingService: SourceIndexingService;

  constructor(
    billing: ContentBillingPort,
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly oauthService = new ConnectorOAuthService(registry),
  ) {
    this.indexingService = new SourceIndexingService(billing);
  }

  async enqueueManualRun(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    enqueue: (payload: {
      runId: string;
      teamId: string;
      workspaceId: string;
      connectorId: string;
      userId: string;
    }) => Promise<{ id?: string | number } | null>;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.sync",
    });
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!connector || connector.status === "disabled") {
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }
    if (connector.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector must be active before syncing",
      );
    }

    const run = await createSyncRunRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: connector.id,
      triggerType: "manual",
      status: "queued",
      createdBy: input.userId,
    });
    const job = await input.enqueue({
      runId: run.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: connector.id,
      userId: input.userId,
    });
    return { run, jobId: job?.id === undefined ? null : String(job.id) };
  }

  async listRuns(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listSyncRunRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    return { items };
  }

  async createScheduledRun(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
  }) {
    return createSyncRunRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      triggerType: "scheduled",
      status: "queued",
      createdBy: null,
    });
  }

  async createBackfillRun(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    createdBy?: string | null;
    metadataJson?: Record<string, unknown>;
  }) {
    return createSyncRunRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      triggerType: "backfill",
      status: "queued",
      createdBy: input.createdBy ?? null,
      metadataJson: input.metadataJson,
    });
  }

  async createWebhookRun(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    metadataJson?: Record<string, unknown>;
  }) {
    return createSyncRunRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      triggerType: "webhook",
      status: "queued",
      createdBy: null,
      metadataJson: input.metadataJson,
    });
  }

  async run(input: {
    runId: string;
    teamId: string;
    workspaceId: string;
    connectorId: string;
    userId: string;
    targetExternalIds?: string[];
  }) {
    const connector = await findSourceConnectorRecord(input);
    if (!connector || connector.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector is not active",
      );
    }
    const run = await findSyncRunRecord(input);
    if (!run) {
      throw new ConnectorError(
        404,
        "CONNECTOR_SYNC_RUN_NOT_FOUND",
        "Connector sync run not found",
      );
    }
    if (run.status === "succeeded" || run.status === "failed") {
      return run;
    }

    await updateSyncRunRecord({
      ...input,
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
    });

    let discoveredCount = 0;
    let indexedCount = 0;
    let failedCount = 0;
    const itemFailures: Array<Record<string, unknown>> = [];

    try {
      const adapter = this.registry.getAdapter(connector.connectorType);
      const accessToken = await this.oauthService.getRuntimeToken({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        accountId: connector.oauthAccountId,
        connectorType: connector.connectorType,
      });
      const targetExternalIdSet = input.targetExternalIds?.length
        ? new Set(input.targetExternalIds)
        : null;

      for await (const item of adapter.discover({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: connector.id,
        connectorType: connector.connectorType,
        config: connector.configJson,
        accessToken,
      })) {
        if (targetExternalIdSet && !targetExternalIdSet.has(item.externalId)) {
          continue;
        }
        discoveredCount += 1;
        await incrementSyncRunCounts({
          ...input,
          discoveredDelta: 1,
        });

        try {
          const indexed = await this.upsertItem({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            connectorId: connector.id,
            connectorType: connector.connectorType,
            config: connector.configJson,
            runId: input.runId,
            userId: input.userId,
            accessToken,
            item,
          });
          if (indexed) {
            indexedCount += 1;
            await incrementSyncRunCounts({
              ...input,
              indexedDelta: 1,
            });
          }
        } catch (error) {
          failedCount += 1;
          const summary = asErrorSummary(error);
          itemFailures.push({
            externalId: item.externalId,
            ...summary,
          });
          await incrementSyncRunCounts({
            ...input,
            failedDelta: 1,
            metadataPatch: {
              itemFailures: itemFailures.slice(-20),
            },
          });
        }
      }

      const now = new Date();
      const finalRun = await updateSyncRunRecord({
        ...input,
        status: "succeeded",
        discoveredCount,
        indexedCount,
        failedCount,
        metadataJson: itemFailures.length ? { itemFailures } : {},
        finishedAt: now,
        heartbeatAt: now,
      });
      await touchConnectorScheduleAfterSync({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: connector.id,
        lastIndexedAt: now,
        frequencyMinutes: connector.periodicIndexingEnabled
          ? connector.indexingFrequencyMinutes
          : null,
        status: "active",
        lastError: null,
      });
      return finalRun;
    } catch (error) {
      const summary = asErrorSummary(error);
      const now = new Date();
      await updateSyncRunRecord({
        ...input,
        status: "failed",
        discoveredCount,
        indexedCount,
        failedCount,
        errorCode: summary.code,
        errorMessage: summary.message,
        metadataJson: itemFailures.length ? { itemFailures } : {},
        finishedAt: now,
        heartbeatAt: now,
      });
      await touchConnectorScheduleAfterSync({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: connector.id,
        lastIndexedAt: now,
        frequencyMinutes: connector.periodicIndexingEnabled
          ? connector.indexingFrequencyMinutes
          : null,
        status: "error",
        lastError: summary.message,
      });
      throw error;
    }
  }

  private async upsertItem(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    connectorType: string;
    config: Record<string, unknown>;
    runId: string;
    userId: string;
    accessToken: string;
    item: ConnectorItem;
  }) {
    const existing = await findSourceRecordByConnectorExternalId({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      externalId: input.item.externalId,
    });

    if (existing && shouldSkipExtract({ existing, item: input.item })) {
      await updateSourceRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: existing.id,
        title: normalizeSourceTitle(input.item.title),
        syncRunId: input.runId,
        externalUri: input.item.externalUri,
        externalUpdatedAt: input.item.externalUpdatedAt,
        mimeType: input.item.mimeType,
        sizeBytes: input.item.sizeBytes,
        metadata: {
          ...(existing.metadata ?? {}),
          ...input.item.metadata,
          connectorType: input.connectorType,
        },
      });
      return false;
    }

    const adapter = this.registry.getAdapter(input.connectorType);
    const extracted = await adapter.extract({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      config: input.config,
      accessToken: input.accessToken,
      item: input.item,
    });
    const contentText = extracted.markdown ?? extracted.contentText;
    const contentHash = extracted.item.contentHash ?? computeContentHash(contentText);
    const title = normalizeSourceTitle(extracted.item.title);

    const source = existing
      ? await updateSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: existing.id,
          title,
          contentText,
          syncRunId: input.runId,
          externalId: extracted.item.externalId,
          externalUri: extracted.item.externalUri,
          externalUpdatedAt: extracted.item.externalUpdatedAt,
          mimeType: extracted.item.mimeType,
          sizeBytes: extracted.item.sizeBytes,
          contentHash,
          metadata: {
            ...(existing.metadata ?? {}),
            ...extracted.item.metadata,
            connectorType: input.connectorType,
            parentExternalId: extracted.parentExternalId ?? null,
          },
        })
      : await createSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          title,
          contentText,
          createdBy: input.userId,
          ingestKind: "connector",
          sourceType: "connector",
          connectorId: input.connectorId,
          syncRunId: input.runId,
          externalId: extracted.item.externalId,
          externalUri: extracted.item.externalUri,
          externalUpdatedAt: extracted.item.externalUpdatedAt,
          mimeType: extracted.item.mimeType,
          sizeBytes: extracted.item.sizeBytes,
          contentHash,
          metadata: {
            ...extracted.item.metadata,
            connectorType: input.connectorType,
            parentExternalId: extracted.parentExternalId ?? null,
          },
        });

    if (!source) {
      throw new ConnectorError(
        500,
        "CONNECTOR_SOURCE_UPSERT_FAILED",
        "Failed to upsert connector source",
      );
    }

    const revision = await createSourceRevisionRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: source.id,
      contentHash,
      externalUpdatedAt: extracted.item.externalUpdatedAt,
    });

    await this.indexingService.indexSourceRevision({
      workspaceId: input.workspaceId,
      sourceId: source.id,
      userId: input.userId,
      sourceRevisionId: revision.id,
      parsedTokens: Math.max(1, Math.ceil(contentText.length / 4)),
      idempotencyKey: `connector-sync:${input.connectorId}:${extracted.item.externalId}:${contentHash}`,
    });

    return true;
  }
}

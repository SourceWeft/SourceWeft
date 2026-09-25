import { createHash } from "node:crypto";
import type { ContentBillingPort } from "../content/billing-port";
import { SourceIndexingService } from "../sources";
import {
  createSourceRecord,
  createSourceRevisionRecord,
  estimateIngestionPages,
  findSourceRecordByConnectorExternalId,
  updateSourceRecord,
} from "../sources";
import { getBillingDeploymentCapabilities } from "../../billing-host/bindings";
import { workspaceService } from "../workspace";
import { ConnectorError, toConnectorError } from "./errors";
import { IngestionPageBudget, isPagesLimitExceeded } from "./ingestion-budget";
import { requireConnectorWorkspace } from "./permissions";
import {
  createSyncRunRecord,
  createSyncRunRecordIfNoActiveRun,
  attachScheduleOccurrenceRun,
  completeScheduleOccurrence,
  commitConnectorSyncPage,
  archiveConnectorSourcesNotSeenInRun,
  findSourceConnectorRecord,
  findSyncRunRecord,
  getOrResetConnectorSyncState,
  resetConnectorSyncState,
  isConnectorScheduleEnabled,
  skipScheduleOccurrenceByRunId,
  tryAcquireConnectorSyncLock,
  hardDeleteSourceConnectorRecord,
  incrementSyncRunCounts,
  listSyncRunRecords,
  listWorkspaceSyncRunRecords,
  markConnectorSyncBlockChecked,
  touchConnectorAfterSync,
  updateSourceConnectorRecord,
  updateSyncRunRecord,
} from "./repository";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type {
  ConnectorDirectoryNode,
  ConnectorItem,
  ConnectorSyncBlock,
  ConnectorSyncReadinessResult,
  ConnectorSyncRunTriggerType,
  SourceConnectorRecord,
} from "./types";

type RunnableConnectorStatus = "active" | "paused" | "error";

/**
 * A platform-imposed stop: the run ends `blocked`, keeps everything committed
 * so far, and leaves the in-progress page uncommitted so the next run resumes
 * there. Thrown before the blocked item writes anything.
 */
class ConnectorSyncBlocked extends Error {
  constructor(
    readonly reason: ConnectorSyncBlock["reason"],
    readonly requestedPages: number | null,
    readonly availablePages: number | null,
  ) {
    super(
      reason === "PAGES_LIMIT_EXCEEDED"
        ? "Ingestion page quota is exhausted; sync paused until pages are available"
        : "Connector owner is no longer a team member; reconnect it from a current member to resume syncing",
    );
    this.name = "ConnectorSyncBlocked";
  }
}

type UpsertItemResult =
  | { kind: "indexed" }
  | { kind: "unchanged" }
  | { kind: "oversized"; requestedPages: number; cycleCapacity: number };

export type ResolveConnectorBillingActor = (input: {
  teamId: string;
  ownerUserId: string | null;
  triggerUserId: string;
}) => Promise<string | null>;

/**
 * A connector's ingestion is always paid by its owner, whatever triggered the
 * run (manual, schedule, webhook, backfill). An owner who has left the team has
 * no billing account, so the run is blocked rather than billed to someone else.
 * Without commercial billing there is no account to charge and the actor is
 * attribution only.
 */
export const resolveConnectorBillingActor: ResolveConnectorBillingActor =
  async (input) => {
    if (!getBillingDeploymentCapabilities().billing.available) {
      return input.ownerUserId ?? input.triggerUserId;
    }
    if (!input.ownerUserId) return null;
    const membership = await workspaceService.getOrganizationMembership({
      organizationId: input.teamId,
      userId: input.ownerUserId,
    });
    return membership ? input.ownerUserId : null;
  };

function computeContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function connectorScopeHash(type: string, config: Record<string, unknown>) {
  return computeContentHash(
    JSON.stringify({ type, config: canonicalJson(config) }),
  );
}

/** Existing adapters explicitly use a full scan without a durable cursor. */
async function* legacyDiscoveryPages(items: AsyncIterable<ConnectorItem>) {
  for await (const item of items) {
    yield {
      items: [item],
      deletedExternalIds: [],
      continuation: null,
      checkpoint: null,
      complete: false,
      reconcileMissing: false,
    };
  }
  yield {
    items: [],
    deletedExternalIds: [],
    continuation: null,
    checkpoint: null,
    complete: true,
    reconcileMissing: false,
  };
}

function normalizeSourceTitle(title: string) {
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 200) : "Connector Source";
}

function normalizeDirectoryTitle(title: string) {
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 200) : "Connector Folder";
}

function asErrorSummary(error: unknown) {
  const connectorError = toConnectorError(error);
  return {
    code: connectorError.code,
    message: connectorError.message,
  };
}

function resolveNextScheduledAt(frequencyMinutes: number | null) {
  if (!frequencyMinutes || frequencyMinutes <= 0) {
    return null;
  }
  return new Date(Date.now() + frequencyMinutes * 60 * 1000);
}

function withSyncReadinessMetadata(
  configJson: Record<string, unknown>,
  readiness: ConnectorSyncReadinessResult,
) {
  return {
    ...configJson,
    syncReadiness: {
      ready: false,
      reason: readiness.reason ?? "connector_not_ready",
      message: readiness.message ?? "Connector is not ready to sync.",
      checkedAt: new Date().toISOString(),
    },
  };
}

function hasSyncReadinessMetadata(configJson: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(configJson, "syncReadiness");
}

function withoutSyncReadinessMetadata(configJson: Record<string, unknown>) {
  if (!hasSyncReadinessMetadata(configJson)) {
    return configJson;
  }
  const { syncReadiness: _syncReadiness, ...rest } = configJson;
  return rest;
}

function skippedRunMetadata(
  readiness: ConnectorSyncReadinessResult,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    reason: readiness.reason ?? "connector_not_ready",
    readinessReason: readiness.reason ?? "connector_not_ready",
    message: readiness.message ?? "Connector is not ready to sync.",
    readiness: {
      ready: false,
      reason: readiness.reason ?? "connector_not_ready",
      message: readiness.message ?? "Connector is not ready to sync.",
      ...(readiness.metadata ? { metadata: readiness.metadata } : {}),
    },
  };
}

function shouldSkipExtract(input: {
  existing: Awaited<ReturnType<typeof findSourceRecordByConnectorExternalId>>;
  item: ConnectorItem;
}) {
  if (!input.existing) {
    return false;
  }
  // Only a completed index is evidence the item is current. A failed,
  // processing or never-indexed row carries the new watermark without the
  // chunks, so it must be reprocessed.
  if (input.existing.status !== "indexed") {
    return false;
  }
  if (input.item.metadata.forceRefetch) {
    return false;
  }
  if (
    input.item.contentHash &&
    input.existing.contentHash === input.item.contentHash
  ) {
    return true;
  }
  if (
    !input.item.contentHash &&
    input.item.externalUpdatedAt &&
    input.existing.externalUpdatedAt ===
      input.item.externalUpdatedAt.toISOString()
  ) {
    return true;
  }
  return false;
}

function canRunConnectorStatus(
  status: string,
): status is RunnableConnectorStatus {
  return status === "active" || status === "paused" || status === "error";
}

function finalConnectorStatusAfterSync(
  status: RunnableConnectorStatus,
): "active" | "paused" {
  return status === "paused" ? "paused" : "active";
}

function isConnectorMissingError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /foreign key constraint/i.test(message) && /connector/i.test(message);
}

export class ConnectorSyncOrchestrator {
  private readonly indexingService: SourceIndexingService;

  constructor(
    private readonly billing: ContentBillingPort,
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly oauthService = new ConnectorOAuthService(registry),
    private readonly resolveBillingActor: ResolveConnectorBillingActor = resolveConnectorBillingActor,
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
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    if (!canRunConnectorStatus(connector.status)) {
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector must not be disabled before syncing",
      );
    }

    const readiness = await this.checkReadiness({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connector,
    });
    if (!readiness.ready) {
      const now = new Date();
      const run = await createSyncRunRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        triggerType: "manual",
        status: "skipped",
        createdBy: input.userId,
        metadataJson: skippedRunMetadata(readiness),
      });
      const skippedRun = await updateSyncRunRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        runId: run.id,
        finishedAt: now,
        heartbeatAt: now,
      });
      await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        configJson: withSyncReadinessMetadata(connector.configJson, readiness),
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
      return {
        run: skippedRun ?? run,
        jobId: null,
        skipped: true,
        reason: readiness.reason ?? "connector_not_ready",
        message: readiness.message ?? "Connector is not ready to sync.",
      };
    }
    if (hasSyncReadinessMetadata(connector.configJson)) {
      await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        configJson: withoutSyncReadinessMetadata(connector.configJson),
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
    }

    const runResult = await createSyncRunRecordIfNoActiveRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: connector.id,
      triggerType: "manual",
      status: "queued",
      createdBy: input.userId,
    });
    if (!runResult.run) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    if (runResult.existing) {
      return {
        run: runResult.run,
        jobId: null,
        alreadyRunning: true,
        message: "Connector sync is already queued or running.",
      };
    }
    const run = runResult.run;
    if (connector.status !== "active" || connector.lastError) {
      await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
    }
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

  async listWorkspaceRuns(input: {
    workspaceId: string;
    userId: string;
    status?: "active";
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listWorkspaceSyncRunRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      status: input.status,
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

  async enqueueScheduledRun(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    userId: string;
    occurrenceId?: string;
    existingRunId?: string | null;
    enqueue: (payload: {
      runId: string;
      teamId: string;
      workspaceId: string;
      connectorId: string;
      userId: string;
    }) => Promise<{ id?: string | number } | null>;
  }) {
    const connector = await findSourceConnectorRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
    });
    if (
      !connector ||
      (connector.status !== "active" && connector.status !== "error")
    ) {
      return {
        run: null,
        jobId: null,
        skipped: true,
        reason: "connector_not_active",
        message: "Connector is not active.",
      };
    }

    const readiness = await this.checkReadiness({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connector,
    });
    if (!readiness.ready) {
      const now = new Date();
      const run = await createSyncRunRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        triggerType: "scheduled",
        status: "skipped",
        createdBy: null,
        metadataJson: skippedRunMetadata(readiness, {
          scheduledAt: now.toISOString(),
        }),
      });
      const skippedRun = await updateSyncRunRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        runId: run.id,
        finishedAt: now,
        heartbeatAt: now,
      });
      await updateSourceConnectorRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        configJson: withSyncReadinessMetadata(connector.configJson, readiness),
        nextScheduledAt: resolveNextScheduledAt(
          connector.periodicIndexingEnabled
            ? connector.indexingFrequencyMinutes
            : null,
        ),
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
      return {
        run: skippedRun ?? run,
        jobId: null,
        skipped: true,
        reason: readiness.reason ?? "connector_not_ready",
        message: readiness.message ?? "Connector is not ready to sync.",
      };
    }
    if (hasSyncReadinessMetadata(connector.configJson)) {
      await updateSourceConnectorRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        configJson: withoutSyncReadinessMetadata(connector.configJson),
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
    }

    let run;
    try {
      if (input.existingRunId) {
        run = await findSyncRunRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: input.connectorId,
          runId: input.existingRunId,
        });
      } else {
        const created = await createSyncRunRecordIfNoActiveRun({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: input.connectorId,
          triggerType: "scheduled",
          status: "queued",
          createdBy: null,
        });
        if (created.existing) {
          return {
            run: created.run,
            jobId: null,
            skipped: true,
            reason: "connector_already_running",
          };
        }
        run = created.run;
      }
    } catch (error) {
      if (isConnectorMissingError(error)) {
        return {
          run: null,
          jobId: null,
          skipped: true,
          reason: "connector_deleted",
        };
      }
      throw error;
    }
    if (!run) {
      return {
        run: null,
        jobId: null,
        skipped: true,
        reason: "run_missing",
      };
    }
    if (input.occurrenceId) {
      await attachScheduleOccurrenceRun({
        occurrenceId: input.occurrenceId,
        runId: run.id,
      });
    }
    if (connector.status !== "active" || connector.lastError) {
      await updateSourceConnectorRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: connector.id,
        status: finalConnectorStatusAfterSync(connector.status),
        lastError: null,
      });
    }
    const job = await input.enqueue({
      runId: run.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      userId: input.userId,
    });
    return { run, jobId: job?.id === undefined ? null : String(job.id) };
  }

  /**
   * Resumes a quota-blocked connector as soon as its owner has pages again,
   * whether or not it has a schedule. Nothing is queued while pages are still
   * short; the check time is recorded so the caller can back off.
   */
  async enqueueQuotaResumeRun(input: {
    connector: SourceConnectorRecord;
    enqueue: (payload: {
      runId: string;
      teamId: string;
      workspaceId: string;
      connectorId: string;
      userId: string;
    }) => Promise<{ id?: string | number } | null>;
  }) {
    const { connector } = input;
    if (connector.syncBlock?.reason !== "PAGES_LIMIT_EXCEEDED") {
      return { queued: false as const, reason: "not_quota_blocked" };
    }
    const billingUserId = await this.resolveBillingActor({
      teamId: connector.teamId,
      ownerUserId: connector.createdBy,
      triggerUserId: connector.createdBy ?? "system",
    });
    const admission = billingUserId
      ? await new IngestionPageBudget(
          this.billing,
          connector.teamId,
          billingUserId,
        ).admit(Math.max(1, connector.syncBlock.requestedPages ?? 1))
      : null;
    // Resume once the blocked item fits. An item that no longer fits even a
    // full cycle is skipped by the run as oversized, so it must not wait.
    if (!billingUserId || !admission || admission.outcome === "insufficient") {
      await markConnectorSyncBlockChecked({
        connectorId: connector.id,
        checkedAt: new Date(),
      });
      return {
        queued: false as const,
        reason: billingUserId
          ? "pages_unavailable"
          : "billing_owner_unavailable",
      };
    }
    const created = await createSyncRunRecordIfNoActiveRun({
      teamId: connector.teamId,
      workspaceId: connector.workspaceId,
      connectorId: connector.id,
      triggerType: "backfill",
      status: "queued",
      createdBy: null,
      metadataJson: {
        resume: "quota",
        blockedRunId: connector.syncBlock.runId,
      },
    });
    if (!created.run || created.existing) {
      return { queued: false as const, reason: "connector_already_running" };
    }
    await input.enqueue({
      runId: created.run.id,
      teamId: connector.teamId,
      workspaceId: connector.workspaceId,
      connectorId: connector.id,
      userId: billingUserId,
    });
    return { queued: true as const, run: created.run };
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
    if (!connector || !canRunConnectorStatus(connector.status)) {
      if (!connector) {
        await hardDeleteSourceConnectorRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: input.connectorId,
        });
      }
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector must not be disabled before syncing",
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
    if (
      run.triggerType === "scheduled" &&
      run.status === "queued" &&
      (connector.status === "paused" ||
        !(await isConnectorScheduleEnabled(connector.id)))
    ) {
      const now = new Date();
      const skipped = await updateSyncRunRecord({
        ...input,
        status: "skipped",
        finishedAt: now,
        heartbeatAt: now,
        errorCode: "SCHEDULE_PAUSED",
        errorMessage: "Scheduled sync was paused before execution",
      });
      await skipScheduleOccurrenceByRunId(run.id);
      return skipped ?? run;
    }
    if (
      run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "skipped" ||
      run.status === "blocked"
    ) {
      return run;
    }

    const releaseSyncLock = await tryAcquireConnectorSyncLock(connector.id);
    if (!releaseSyncLock) {
      throw new ConnectorError(
        409,
        "CONNECTOR_SYNC_ALREADY_RUNNING",
        "Another sync is already running for this connector",
      );
    }

    try {
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
      const oversizedItems: Array<Record<string, unknown>> = [];
      // Only an untargeted run re-covers what an earlier run was blocked on, so
      // only it may clear the block; a webhook run for other items keeps it.
      const clearsSyncBlock = !input.targetExternalIds?.length;
      const runMetadata = () => ({
        ...(itemFailures.length ? { itemFailures } : {}),
        ...(oversizedItems.length ? { oversizedItems } : {}),
      });

      try {
        const billingUserId = await this.resolveBillingActor({
          teamId: input.teamId,
          ownerUserId: connector.createdBy,
          triggerUserId: input.userId,
        });
        if (!billingUserId) {
          throw new ConnectorSyncBlocked(
            "CONNECTOR_BILLING_OWNER_UNAVAILABLE",
            null,
            null,
          );
        }
        const budget = new IngestionPageBudget(
          this.billing,
          input.teamId,
          billingUserId,
        );
        // Out of pages before starting: stop before any provider traffic.
        const opening = await budget.admit(1);
        if (opening.outcome !== "admit") {
          throw new ConnectorSyncBlocked(
            "PAGES_LIMIT_EXCEEDED",
            1,
            opening.outcome === "insufficient" ? opening.available : 0,
          );
        }

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

        const scopeHash = connectorScopeHash(
          connector.connectorType,
          connector.configJson,
        );
        const syncState = adapter.discoverPages
          ? await getOrResetConnectorSyncState({
              connectorId: connector.id,
              scopeHash,
            })
          : null;
        let syncGeneration = syncState?.generation ?? 0;
        const discoveryInput = {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          connectorType: connector.connectorType,
          connectorName: connector.name,
          config: connector.configJson,
          accessToken,
          ...(syncState
            ? {
                cursor: {
                  committed: syncState.committedCursorJson,
                  continuation: syncState.pageCursorJson,
                },
              }
            : {}),
        };
        const pages = adapter.discoverPages
          ? adapter.discoverPages(discoveryInput)
          : legacyDiscoveryPages(adapter.discover(discoveryInput));
        let completedDiscovery = false;
        const allowsDeletion = adapter
          .getManifest()
          .sync.resources.some((resource) => resource.supportsDeleteDetection);
        for await (const page of pages) {
          let pageFailures = 0;
          for (const item of page.items) {
            if (
              targetExternalIdSet &&
              !targetExternalIdSet.has(item.externalId)
            ) {
              continue;
            }
            discoveredCount += 1;
            await incrementSyncRunCounts({
              ...input,
              discoveredDelta: 1,
            });

            try {
              const result = await this.upsertItem({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                connectorId: connector.id,
                connectorType: connector.connectorType,
                connectorName: connector.name,
                config: connector.configJson,
                runId: input.runId,
                userId: input.userId,
                billingUserId,
                budget,
                accessToken,
                item,
              });
              if (result.kind === "indexed") {
                indexedCount += 1;
                await incrementSyncRunCounts({
                  ...input,
                  indexedDelta: 1,
                });
              } else if (result.kind === "oversized") {
                oversizedItems.push({
                  externalId: item.externalId,
                  title: item.title,
                  requestedPages: result.requestedPages,
                  cycleCapacity: result.cycleCapacity,
                });
                await incrementSyncRunCounts({
                  ...input,
                  metadataPatch: { oversizedItems: oversizedItems.slice(-20) },
                });
              }
            } catch (error) {
              // A block ends the whole run here: no later item is extracted or
              // embedded, and this page's cursor is never committed.
              if (error instanceof ConnectorSyncBlocked) throw error;
              failedCount += 1;
              pageFailures += 1;
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
          if (pageFailures > 0) {
            throw new ConnectorError(
              502,
              "CONNECTOR_PAGE_INCOMPLETE",
              `${pageFailures} connector items failed; the page will be replayed`,
            );
          }
          if (page.deletedExternalIds?.length) {
            if (!allowsDeletion) {
              throw new ConnectorError(
                500,
                "CONNECTOR_DELETE_UNSUPPORTED",
                "Adapter reported deletions without declaring delete detection",
              );
            }
            for (const externalId of page.deletedExternalIds) {
              const source = await findSourceRecordByConnectorExternalId({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                connectorId: connector.id,
                externalId,
              });
              if (source) {
                await updateSourceRecord({
                  teamId: input.teamId,
                  workspaceId: input.workspaceId,
                  sourceId: source.id,
                  status: "archived",
                });
              }
            }
          }
          if (page.reconcileMissing) {
            if (!page.complete || !allowsDeletion || targetExternalIdSet) {
              throw new ConnectorError(
                500,
                "CONNECTOR_RECONCILIATION_INVALID",
                "Full reconciliation requires a complete unrestricted scan with delete detection",
              );
            }
            await archiveConnectorSourcesNotSeenInRun({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              connectorId: connector.id,
              runId: input.runId,
            });
          }
          if (syncState) {
            const committed = await commitConnectorSyncPage({
              connectorId: connector.id,
              scopeHash,
              expectedGeneration: syncGeneration,
              continuation: page.continuation,
              checkpoint: page.checkpoint,
              complete: page.complete,
            });
            syncGeneration = committed.generation;
          }
          if (page.complete) completedDiscovery = true;
        }
        if (!completedDiscovery) {
          throw new ConnectorError(
            502,
            "CONNECTOR_DISCOVERY_INCOMPLETE",
            "Connector discovery ended without a completed page",
          );
        }

        const now = new Date();
        const finalRun = await updateSyncRunRecord({
          ...input,
          status: failedCount === 0 ? "succeeded" : "failed",
          discoveredCount,
          indexedCount,
          failedCount,
          metadataJson: runMetadata(),
          finishedAt: now,
          heartbeatAt: now,
        });
        await touchConnectorAfterSync({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          lastIndexedAt: now,
          status:
            failedCount === 0
              ? finalConnectorStatusAfterSync(connector.status)
              : "error",
          lastError:
            failedCount === 0 ? null : `${failedCount} connector items failed`,
          syncBlock: clearsSyncBlock ? null : undefined,
        });
        await completeScheduleOccurrence({
          runId: input.runId,
          succeeded: failedCount === 0,
          errorCode: failedCount ? "CONNECTOR_ITEMS_FAILED" : null,
        });
        return finalRun;
      } catch (error) {
        if (error instanceof ConnectorSyncBlocked) {
          return this.finishBlockedRun({
            ...input,
            connectorStatus: connector.status,
            block: error,
            discoveredCount,
            indexedCount,
            failedCount,
            metadataJson: runMetadata(),
          });
        }
        const summary = asErrorSummary(error);
        if (summary.code === "CONNECTOR_CURSOR_EXPIRED") {
          await resetConnectorSyncState({
            connectorId: connector.id,
            scopeHash: connectorScopeHash(
              connector.connectorType,
              connector.configJson,
            ),
          });
        }
        const now = new Date();
        await updateSyncRunRecord({
          ...input,
          status: "failed",
          discoveredCount,
          indexedCount,
          failedCount,
          errorCode: summary.code,
          errorMessage: summary.message,
          metadataJson: runMetadata(),
          finishedAt: now,
          heartbeatAt: now,
        });
        await touchConnectorAfterSync({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          lastIndexedAt: now,
          status: connector.status === "paused" ? "paused" : "error",
          lastError: summary.message,
          syncBlock: clearsSyncBlock ? null : undefined,
        });
        await completeScheduleOccurrence({
          runId: input.runId,
          succeeded: false,
          errorCode: summary.code,
        });
        throw error;
      }
    } finally {
      await releaseSyncLock();
    }
  }

  private async finishBlockedRun(input: {
    runId: string;
    teamId: string;
    workspaceId: string;
    connectorId: string;
    connectorStatus: RunnableConnectorStatus;
    block: ConnectorSyncBlocked;
    discoveredCount: number;
    indexedCount: number;
    failedCount: number;
    metadataJson: Record<string, unknown>;
  }) {
    const now = new Date();
    const blockedRun = await updateSyncRunRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      runId: input.runId,
      status: "blocked",
      discoveredCount: input.discoveredCount,
      indexedCount: input.indexedCount,
      failedCount: input.failedCount,
      errorCode: input.block.reason,
      errorMessage: input.block.message,
      metadataJson: {
        ...input.metadataJson,
        block: {
          requestedPages: input.block.requestedPages,
          availablePages: input.block.availablePages,
        },
      },
      finishedAt: now,
      heartbeatAt: now,
    });
    // Blocked is not broken: the connector keeps its status unless ordinary
    // item failures in the same run already made it an error.
    await touchConnectorAfterSync({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      lastIndexedAt: now,
      status:
        input.failedCount === 0
          ? finalConnectorStatusAfterSync(input.connectorStatus)
          : input.connectorStatus === "paused"
            ? "paused"
            : "error",
      lastError:
        input.failedCount === 0
          ? null
          : `${input.failedCount} connector items failed`,
      syncBlock: {
        reason: input.block.reason,
        runId: input.runId,
        blockedAt: now.toISOString(),
        indexedCount: input.indexedCount,
        requestedPages: input.block.requestedPages,
        availablePages: input.block.availablePages,
      },
    });
    await completeScheduleOccurrence({
      runId: input.runId,
      succeeded: false,
      errorCode: input.block.reason,
    });
    return blockedRun;
  }

  private async upsertItem(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    connectorType: string;
    connectorName?: string;
    config: Record<string, unknown>;
    runId: string;
    userId: string;
    billingUserId: string;
    budget: IngestionPageBudget;
    accessToken: string;
    item: ConnectorItem;
  }): Promise<UpsertItemResult> {
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
        status: "indexed",
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
      return { kind: "unchanged" };
    }

    const adapter = this.registry.getAdapter(input.connectorType);
    const extracted = await adapter.extract({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      connectorName: input.connectorName,
      config: input.config,
      accessToken: input.accessToken,
      item: input.item,
    });
    const contentText = extracted.markdown ?? extracted.contentText;
    const contentHash =
      extracted.item.contentHash ?? computeContentHash(contentText);
    const title = normalizeSourceTitle(extracted.item.title);
    const metadata = {
      ...(existing?.metadata ?? {}),
      ...extracted.item.metadata,
      connectorType: input.connectorType,
      parentExternalId: extracted.parentExternalId ?? null,
    };

    if (
      existing &&
      existing.status === "indexed" &&
      existing.contentHash === contentHash
    ) {
      const parentSourceId = await this.upsertDirectoryPath({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        connectorType: input.connectorType,
        runId: input.runId,
        userId: input.userId,
        directoryPath: extracted.directoryPath,
      });
      await updateSourceRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: existing.id,
        status: "indexed",
        title,
        syncRunId: input.runId,
        externalId: extracted.item.externalId,
        externalUri: extracted.item.externalUri,
        externalUpdatedAt: extracted.item.externalUpdatedAt,
        mimeType: extracted.item.mimeType,
        sizeBytes: extracted.item.sizeBytes,
        contentHash,
        parentSourceId,
        metadata,
      });
      return { kind: "unchanged" };
    }

    // Admission before any write: a blocked item leaves no source, revision or
    // directory behind, and a replay of this page starts from a clean slate.
    // The estimate is the one indexing settles, computed from the same text.
    const pages = estimateIngestionPages({
      mimeType: extracted.item.mimeType,
      metadata,
      contentText,
    });
    if (pages !== null) {
      const admission = await input.budget.admit(pages);
      if (admission.outcome === "insufficient") {
        throw new ConnectorSyncBlocked(
          "PAGES_LIMIT_EXCEEDED",
          admission.requested,
          admission.available,
        );
      }
      if (admission.outcome === "oversized") {
        // Waiting a cycle cannot admit it, so blocking here would stall every
        // item behind it forever. Skip it without new content: its watermark
        // is recorded only once it indexes, so any scan that rediscovers it
        // re-checks it. An existing version is marked seen by this run so a
        // reconciling scan keeps it searchable instead of archiving it.
        if (existing) {
          const parentSourceId = await this.upsertDirectoryPath({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            connectorId: input.connectorId,
            connectorType: input.connectorType,
            runId: input.runId,
            userId: input.userId,
            directoryPath: extracted.directoryPath,
          });
          await updateSourceRecord({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            sourceId: existing.id,
            syncRunId: input.runId,
            parentSourceId,
          });
        }
        return {
          kind: "oversized",
          requestedPages: admission.requested,
          cycleCapacity: admission.cycleCapacity,
        };
      }
    }

    const parentSourceId = await this.upsertDirectoryPath({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      runId: input.runId,
      userId: input.userId,
      directoryPath: extracted.directoryPath,
    });

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
          parentSourceId,
          metadata,
        })
      : await createSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          title,
          contentText,
          createdBy: input.userId,
          ingestKind: "connector",
          sourceType: "connector",
          parentSourceId,
          connectorId: input.connectorId,
          syncRunId: input.runId,
          externalId: extracted.item.externalId,
          externalUri: extracted.item.externalUri,
          externalUpdatedAt: extracted.item.externalUpdatedAt,
          mimeType: extracted.item.mimeType,
          sizeBytes: extracted.item.sizeBytes,
          contentHash,
          metadata,
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

    try {
      await this.indexingService.indexSourceRevision({
        workspaceId: input.workspaceId,
        sourceId: source.id,
        userId: input.billingUserId,
        sourceRevisionId: revision.id,
        parsedTokens: Math.max(1, Math.ceil(contentText.length / 4)),
        idempotencyKey: `connector-sync:${input.connectorId}:${extracted.item.externalId}:${contentHash}`,
        pageAdmission: "checked_by_caller",
      });
    } catch (error) {
      // A concurrent spender won the race to the last pages. The source is
      // already `failed`, so the next run reprocesses it; this run stops.
      if (isPagesLimitExceeded(error)) {
        const details = (error as { details?: Record<string, unknown> })
          .details;
        throw new ConnectorSyncBlocked(
          "PAGES_LIMIT_EXCEEDED",
          typeof details?.requested === "number" ? details.requested : pages,
          typeof details?.available === "number" ? details.available : null,
        );
      }
      throw error;
    }
    if (pages !== null) input.budget.consumed(pages);

    return { kind: "indexed" };
  }

  private async upsertDirectoryPath(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    connectorType: string;
    runId: string;
    userId: string;
    directoryPath?: ConnectorDirectoryNode[];
  }) {
    let parentSourceId: string | null = null;
    const directoryPath = input.directoryPath ?? [];

    for (const node of directoryPath) {
      const title = normalizeDirectoryTitle(node.title);
      const metadata = {
        ...(node.metadata ?? {}),
        connectorManagedDirectory: true,
        connectorType: input.connectorType,
        connectorDirectoryExternalId: node.externalId,
        lastSeenRunId: input.runId,
      };
      const existing = await findSourceRecordByConnectorExternalId({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        externalId: node.externalId,
      });

      let directory: Awaited<ReturnType<typeof createSourceRecord>> | null;
      if (existing) {
        directory = await updateSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sourceId: existing.id,
          title,
          parentSourceId,
          connectorId: input.connectorId,
          syncRunId: input.runId,
          externalId: node.externalId,
          externalUri: node.externalUri ?? null,
          mimeType: "inode/directory",
          sizeBytes: null,
          contentHash: null,
          metadata: {
            ...(existing.metadata ?? {}),
            ...metadata,
          },
          status: "indexed",
          indexedAt: existing.indexedAt
            ? new Date(existing.indexedAt)
            : new Date(),
        });
      } else {
        directory = await createSourceRecord({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          title,
          contentText: "",
          createdBy: input.userId,
          ingestKind: "connector",
          sourceType: "directory",
          parentSourceId,
          connectorId: input.connectorId,
          syncRunId: input.runId,
          externalId: node.externalId,
          externalUri: node.externalUri ?? null,
          mimeType: "inode/directory",
          sizeBytes: null,
          contentHash: null,
          metadata,
          status: "indexed",
          indexedAt: new Date(),
        });
      }

      if (!directory) {
        throw new ConnectorError(
          500,
          "CONNECTOR_DIRECTORY_UPSERT_FAILED",
          "Failed to upsert connector directory source",
        );
      }

      parentSourceId = directory.id;
    }

    return parentSourceId;
  }

  private async checkReadiness(input: {
    teamId: string;
    workspaceId: string;
    connector: Awaited<ReturnType<typeof findSourceConnectorRecord>>;
  }): Promise<ConnectorSyncReadinessResult> {
    const connector = input.connector;
    if (!connector) {
      return {
        ready: false,
        reason: "connector_not_found",
        message: "Connector not found.",
      };
    }

    const adapter = this.registry.getAdapter(connector.connectorType);
    if (!adapter.checkSyncReadiness) {
      return { ready: true };
    }

    const accessToken = await this.oauthService.getRuntimeToken({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: connector.oauthAccountId,
      connectorType: connector.connectorType,
    });

    return adapter.checkSyncReadiness({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: connector.id,
      connectorType: connector.connectorType,
      config: connector.configJson,
      accessToken,
    });
  }
}

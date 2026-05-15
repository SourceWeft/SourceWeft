import type {
  connectorActionRuns,
  connectorOAuthAccounts,
  connectorSyncRuns,
  sourceConnectors,
} from "../../shared/db/schema";
import type {
  ConnectorActionRunRecord,
  ConnectorOAuthAccountRecord,
  ConnectorOAuthAccountSecretRecord,
  ConnectorSyncRunRecord,
  SourceConnectorRecord,
} from "./types";

type OAuthAccountRow = typeof connectorOAuthAccounts.$inferSelect;
type SourceConnectorRow = typeof sourceConnectors.$inferSelect;
type SyncRunRow = typeof connectorSyncRuns.$inferSelect;
type ActionRunRow = typeof connectorActionRuns.$inferSelect;

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export function mapOAuthAccount(row: OAuthAccountRow): ConnectorOAuthAccountRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    connectorType: row.connectorType,
    providerAccountId: row.providerAccountId,
    providerAccountEmail: row.providerAccountEmail,
    displayName: row.displayName,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    status: row.status,
    expiresAt: iso(row.expiresAt),
    lastRefreshAt: iso(row.lastRefreshAt),
    lastError: row.lastError,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapOAuthAccountWithSecret(
  row: OAuthAccountRow,
): ConnectorOAuthAccountSecretRecord {
  return {
    ...mapOAuthAccount(row),
    accessTokenEncrypted: row.accessTokenEncrypted,
    refreshTokenEncrypted: row.refreshTokenEncrypted,
  };
}

export function mapSourceConnector(
  row: SourceConnectorRow,
): SourceConnectorRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    connectorType: row.connectorType,
    name: row.name,
    configJson: row.configJson ?? {},
    oauthAccountId: row.oauthAccountId,
    status: row.status,
    periodicIndexingEnabled: row.periodicIndexingEnabled,
    indexingFrequencyMinutes: row.indexingFrequencyMinutes,
    lastIndexedAt: iso(row.lastIndexedAt),
    nextScheduledAt: iso(row.nextScheduledAt),
    lastError: row.lastError,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapSyncRun(row: SyncRunRow): ConnectorSyncRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    connectorId: row.connectorId,
    triggerType: row.triggerType,
    status: row.status,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    heartbeatAt: iso(row.heartbeatAt),
    discoveredCount: row.discoveredCount,
    indexedCount: row.indexedCount,
    failedCount: row.failedCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    metadataJson: row.metadataJson ?? {},
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapActionRun(row: ActionRunRow): ConnectorActionRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    connectorId: row.connectorId,
    connectorType: row.connectorType,
    actionType: row.actionType,
    riskLevel: row.riskLevel,
    status: row.status,
    requestJson: row.requestJson ?? {},
    requestPreview: row.requestPreview,
    resultJson: row.resultJson ?? {},
    externalId: row.externalId,
    idempotencyKey: row.idempotencyKey,
    approvedBy: row.approvedBy,
    executedBy: row.executedBy,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

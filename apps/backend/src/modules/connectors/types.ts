// ---------------------------------------------------------------------------
// Re-exports from @sourceweft/contracts (canonical type definitions)
// ---------------------------------------------------------------------------

import type {
  ConnectorActionCapability,
  ConnectorActionInput,
  ConnectorActionRiskLevel,
  ConnectorActionResult,
  ConnectorActionRunStatus,
  ConnectorActionSpec,
  ConnectorActionVisibility,
  ConnectorAdapter,
  ConnectorDirectoryNode,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorManifest,
  ConnectorOAuthAccountStatus,
  ConnectorResourceSpec,
  ConnectorStatus,
  ConnectorSyncReadinessResult,
  ConnectorSyncRunStatus,
  ConnectorSyncRunTriggerType,
  ConnectorType,
  ConnectorWebhookPayload,
  ConnectorWebhookTarget,
  ConnectorWebhookTargetAction,
  ConnectorWebhookVerifyInput,
  ConnectorWebhookEventStatus,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";

export type {
  ConnectorActionCapability,
  ConnectorActionInput,
  ConnectorActionRiskLevel,
  ConnectorActionResult,
  ConnectorActionRunStatus,
  ConnectorActionSpec,
  ConnectorActionVisibility,
  ConnectorAdapter,
  ConnectorDirectoryNode,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorManifest,
  ConnectorOAuthAccountStatus,
  ConnectorResourceSpec,
  ConnectorStatus,
  ConnectorSyncReadinessResult,
  ConnectorSyncRunStatus,
  ConnectorSyncRunTriggerType,
  ConnectorType,
  ConnectorWebhookPayload,
  ConnectorWebhookTarget,
  ConnectorWebhookTargetAction,
  ConnectorWebhookVerifyInput,
  ConnectorWebhookEventStatus,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
};

// ---------------------------------------------------------------------------
// Backend-specific record / mapped types
// ---------------------------------------------------------------------------

export type ConnectorActivityKind = "sync" | "action" | "webhook";

export type ConnectorActivityItemRecord = {
  id: string;
  kind: ConnectorActivityKind;
  status: string;
  title: string;
  summaryJson: Record<string, unknown>;
  resultJson: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  linkedRunId: string | null;
  linkedActionId: string | null;
  linkedWebhookEventId: string | null;
};

export type ConnectorWebhookEventRecord = {
  id: string;
  teamId: string | null;
  workspaceId: string | null;
  connectorId: string | null;
  connectorType: string;
  providerEventId: string;
  eventType: string;
  status: ConnectorWebhookEventStatus;
  attempts: number;
  objectId: string | null;
  objectType: string | null;
  syncRunId: string | null;
  payloadMetadataJson: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorOAuthAccountRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  connectorType: string;
  providerAccountId: string | null;
  providerAccountEmail: string | null;
  displayName: string;
  scopes: string[];
  status: ConnectorOAuthAccountStatus;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorOAuthAccountSecretRecord = ConnectorOAuthAccountRecord & {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
};

export type SourceConnectorRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  connectorType: string;
  name: string;
  configJson: Record<string, unknown>;
  oauthAccountId: string | null;
  status: ConnectorStatus;
  periodicIndexingEnabled: boolean;
  indexingFrequencyMinutes: number | null;
  lastIndexedAt: string | null;
  nextScheduledAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorSyncRunRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  connectorId: string;
  triggerType: ConnectorSyncRunTriggerType;
  status: ConnectorSyncRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  discoveredCount: number;
  indexedCount: number;
  failedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  metadataJson: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
};

export type ConnectorActionRunRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  actionType: string;
  agentToolName: string | null;
  riskLevel: ConnectorActionRiskLevel;
  status: ConnectorActionRunStatus;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  resultJson: Record<string, unknown>;
  externalId: string | null;
  idempotencyKey: string;
  approvedBy: string | null;
  executedBy: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentToolTrustRuleStatus = "active" | "revoked";

export type AgentToolTrustRuleRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  domain: string;
  toolName: string;
  connectorId: string | null;
  targetType: string | null;
  targetId: string | null;
  allowedRiskLevels: ConnectorActionRiskLevel[];
  status: AgentToolTrustRuleStatus;
  expiresAt: string | null;
  createdFromConfirmationId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

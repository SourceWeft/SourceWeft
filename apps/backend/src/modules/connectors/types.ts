export type ConnectorType = string;

export type ConnectorActionRiskLevel = "low" | "medium" | "high";
export type ConnectorActionRunStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
export type ConnectorOAuthAccountStatus =
  | "active"
  | "reauth_required"
  | "revoked"
  | "disabled";
export type ConnectorStatus = "active" | "paused" | "error" | "disabled";
export type ConnectorSyncRunTriggerType =
  | "manual"
  | "scheduled"
  | "webhook"
  | "backfill";
export type ConnectorSyncRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
export type ConnectorWebhookEventStatus =
  | "received"
  | "queued"
  | "processed"
  | "ignored"
  | "failed";

export type ConnectorManifest = {
  type: ConnectorType;
  displayName: string;
  auth: {
    kind: "oauth2";
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
    redirectUri?: string;
    authorizationParams?: Record<string, string>;
    sendScope?: boolean;
  };
  sync: {
    supportsIncremental: boolean;
    defaultFrequencyMinutes: number;
    resources: ConnectorResourceSpec[];
  };
  actions: ConnectorActionSpec[];
  configSchema: Record<string, unknown>;
};

export type ConnectorResourceSpec = {
  type: string;
  displayName: string;
  supportsDeleteDetection: boolean;
};

export type ConnectorActionSpec = {
  type: string;
  displayName: string;
  riskLevel: ConnectorActionRiskLevel;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
};

export type OAuthCodeExchangeInput = {
  code: string;
  redirectUri: string;
  scopes: string[];
};

export type OAuthRefreshInput = {
  refreshToken: string;
  scopes: string[];
};

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  providerAccountId?: string | null;
  providerAccountEmail?: string | null;
  displayName?: string | null;
};

export type ConnectorItem = {
  externalId: string;
  externalUri: string | null;
  title: string;
  mimeType: string | null;
  sizeBytes: number | null;
  externalUpdatedAt: Date | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
};

export type ConnectorWebhookVerifyInput = {
  headers: Record<string, string>;
  rawBody: string;
  query: Record<string, string | undefined>;
};

export type ConnectorWebhookEvent = {
  providerEventId: string;
  eventType: string;
  objectId: string | null;
  objectType: string | null;
  workspaceHint?: string | null;
  connectorId?: string | null;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
};

export type ConnectorWebhookTargetAction =
  | "sync"
  | "archive_source"
  | "record_only";

export type ConnectorWebhookTarget = {
  action: ConnectorWebhookTargetAction;
  externalId?: string | null;
  objectId?: string | null;
  objectType?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type ConnectorExtractedContent = {
  item: ConnectorItem;
  contentText: string;
  markdown?: string;
  parentExternalId?: string | null;
};

export type ConnectorDiscoverInput = {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: ConnectorType;
  config: Record<string, unknown>;
  accessToken: string;
  cursor?: Record<string, unknown> | null;
};

export type ConnectorExtractInput = ConnectorDiscoverInput & {
  item: ConnectorItem;
};

export type ConnectorActionInput = {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: ConnectorType;
  actionType: string;
  request: Record<string, unknown>;
  config: Record<string, unknown>;
  accessToken: string;
  idempotencyKey: string;
};

export type ConnectorActionResult = {
  externalId?: string | null;
  result: Record<string, unknown>;
  shouldResync?: boolean;
  resyncExternalIds?: string[];
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

export interface ConnectorAdapter {
  getManifest(): ConnectorManifest;
  exchangeOAuthCode(input: OAuthCodeExchangeInput): Promise<OAuthTokenSet>;
  refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet>;
  discover(input: ConnectorDiscoverInput): AsyncIterable<ConnectorItem>;
  extract(input: ConnectorExtractInput): Promise<ConnectorExtractedContent>;
  executeAction(input: ConnectorActionInput): Promise<ConnectorActionResult>;
  verifyWebhook?(input: ConnectorWebhookVerifyInput): Promise<void>;
  parseWebhookEvent?(
    input: ConnectorWebhookVerifyInput,
  ): Promise<ConnectorWebhookEvent>;
  mapWebhookEventToSyncTargets?(
    event: ConnectorWebhookEvent,
  ): Promise<ConnectorWebhookTarget[]>;
}

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

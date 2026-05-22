import { z } from "zod";

export const connectorStatusSchema = z.enum([
  "active",
  "paused",
  "error",
  "disabled",
]);

export const connectorOAuthAccountStatusSchema = z.enum([
  "active",
  "reauth_required",
  "revoked",
  "disabled",
]);

export const connectorSyncRunTriggerTypeSchema = z.enum([
  "manual",
  "scheduled",
  "webhook",
  "backfill",
]);

export const connectorSyncRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);

export const connectorActionRiskLevelSchema = z.enum(["low", "medium", "high"]);

export const connectorActionVisibilitySchema = z.enum(["agent", "internal"]);

export const connectorActionCapabilitySchema = z.enum([
  "connector_read",
  "connector_write",
  "connector_create",
  "connector_update",
  "connector_delete",
  "connector_append",
  "connector_upload",
  "connector_move",
  "connector_archive",
  "connector_comment",
  "artifact",
]);

export const connectorActionRunStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const connectorWebhookEventStatusSchema = z.enum([
  "received",
  "queued",
  "processed",
  "ignored",
  "failed",
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

const connectorAuthManifestSchema = z.object({
  kind: z.literal("oauth2"),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1)),
  redirectUri: z.string().url().optional(),
  authorizationParams: z.record(z.string(), z.string()).optional(),
  sendScope: z.boolean().optional(),
});

export const connectorResourceSpecSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  supportsDeleteDetection: z.boolean(),
});

export const connectorActionSpecSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  riskLevel: connectorActionRiskLevelSchema,
  requiresApproval: z.boolean(),
  inputSchema: jsonObjectSchema,
  agentToolName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  visibility: connectorActionVisibilitySchema.optional(),
  capabilities: z.array(connectorActionCapabilitySchema).optional(),
  resultSchema: jsonObjectSchema.optional(),
});

export const connectorManifestSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  auth: connectorAuthManifestSchema,
  sync: z.object({
    supportsIncremental: z.boolean(),
    defaultFrequencyMinutes: z.number().int().positive(),
    resources: z.array(connectorResourceSpecSchema),
  }),
  actions: z.array(connectorActionSpecSchema),
  configSchema: jsonObjectSchema,
});

export const connectorOAuthAccountSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  connectorType: z.string(),
  providerAccountId: z.string().nullable(),
  providerAccountEmail: z.string().nullable(),
  displayName: z.string(),
  scopes: z.array(z.string()),
  status: connectorOAuthAccountStatusSchema,
  expiresAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sourceConnectorSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  connectorType: z.string(),
  name: z.string(),
  configJson: jsonObjectSchema,
  oauthAccountId: z.string().nullable(),
  status: connectorStatusSchema,
  periodicIndexingEnabled: z.boolean(),
  indexingFrequencyMinutes: z.number().int().positive().nullable(),
  lastIndexedAt: z.string().nullable(),
  nextScheduledAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const connectorSyncRunSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  connectorId: z.string(),
  triggerType: connectorSyncRunTriggerTypeSchema,
  status: connectorSyncRunStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  discoveredCount: z.number().int().nonnegative(),
  indexedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  metadataJson: jsonObjectSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export const connectorActionRunSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  connectorId: z.string(),
  connectorType: z.string(),
  actionType: z.string(),
  agentToolName: z.string().nullable().optional(),
  riskLevel: connectorActionRiskLevelSchema,
  status: connectorActionRunStatusSchema,
  requestJson: jsonObjectSchema,
  requestPreview: z.string(),
  resultJson: jsonObjectSchema,
  externalId: z.string().nullable(),
  idempotencyKey: z.string(),
  approvedBy: z.string().nullable(),
  executedBy: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const connectorWebhookEventSchema = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  connectorId: z.string().nullable(),
  connectorType: z.string(),
  providerEventId: z.string(),
  eventType: z.string(),
  status: connectorWebhookEventStatusSchema,
  attempts: z.number().int().nonnegative(),
  objectId: z.string().nullable(),
  objectType: z.string().nullable(),
  syncRunId: z.string().nullable(),
  payloadMetadataJson: jsonObjectSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const connectorActivityKindSchema = z.enum([
  "sync",
  "action",
  "webhook",
]);

export const connectorActivityItemSchema = z.object({
  id: z.string(),
  kind: connectorActivityKindSchema,
  status: z.string(),
  title: z.string(),
  summaryJson: jsonObjectSchema,
  resultJson: jsonObjectSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  linkedRunId: z.string().nullable(),
  linkedActionId: z.string().nullable(),
  linkedWebhookEventId: z.string().nullable(),
});

export const listConnectorManifestsResponseSchema = z.object({
  items: z.array(connectorManifestSchema),
});

export const startConnectorOAuthRequestSchema = z.object({
  redirectAfter: z.string().trim().max(4096).optional(),
});

export const startConnectorOAuthResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: z.string(),
});

export const finishConnectorOAuthResponseSchema = z.object({
  account: connectorOAuthAccountSchema,
  redirectAfter: z.string().nullable(),
});

export const listConnectorOAuthAccountsRequestSchema = z.object({
  connectorType: z.string().trim().min(1).optional(),
});

export const listConnectorOAuthAccountsResponseSchema = z.object({
  items: z.array(connectorOAuthAccountSchema),
});

export const createConnectorRequestSchema = z.object({
  connectorType: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  oauthAccountId: z.string().trim().min(1).optional(),
  configJson: jsonObjectSchema.optional(),
  periodicIndexingEnabled: z.boolean().optional(),
  indexingFrequencyMinutes: z.number().int().positive().optional(),
});

export const updateConnectorRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  configJson: jsonObjectSchema.optional(),
  status: z.enum(["active", "paused", "disabled"]).optional(),
  periodicIndexingEnabled: z.boolean().optional(),
  indexingFrequencyMinutes: z.number().int().positive().nullable().optional(),
});

export const deleteConnectorRequestSchema = z.object({
  disable: z.boolean().optional(),
});

export const createConnectorResponseSchema = z.object({
  connector: sourceConnectorSchema,
});

export const updateConnectorResponseSchema = z.object({
  connector: sourceConnectorSchema,
});

export const deleteConnectorResponseSchema = z.object({
  disabled: z.boolean(),
  hardDeleted: z.boolean(),
  connectorId: z.string(),
  indexedContentDeleted: z.boolean().optional(),
  sourcesDeleted: z.number().int().nonnegative().optional(),
  documentsDeleted: z.number().int().nonnegative().optional(),
  authorizationDeleted: z.boolean().optional(),
});

export const deleteConnectorAccountRequestSchema = z.object({});

export const deleteConnectorAccountResponseSchema = z.object({
  deleted: z.boolean(),
  accountId: z.string(),
});

export const listConnectorsRequestSchema = z.object({
  includeDisabled: z.boolean().optional(),
});

export const listConnectorsResponseSchema = z.object({
  items: z.array(sourceConnectorSchema),
});

export const triggerConnectorSyncResponseSchema = z.object({
  run: connectorSyncRunSchema.nullable(),
  jobId: z.string().nullable(),
  skipped: z.boolean().optional(),
  alreadyRunning: z.boolean().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

export const listConnectorSyncRunsResponseSchema = z.object({
  items: z.array(connectorSyncRunSchema),
});

export const listWorkspaceConnectorSyncRunsRequestSchema = z.object({
  status: z.enum(["active"]).optional(),
});

export const listWorkspaceConnectorSyncRunsResponseSchema = z.object({
  items: z.array(connectorSyncRunSchema),
});

export const createConnectorActionRequestSchema = z.object({
  actionType: z.string().trim().min(1),
  requestJson: jsonObjectSchema,
  requestPreview: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().trim().min(1).max(512).optional(),
});

export const createConnectorActionResponseSchema = z.object({
  action: connectorActionRunSchema,
});

export const updateConnectorActionResponseSchema = z.object({
  action: connectorActionRunSchema,
});

export const executeConnectorActionResponseSchema =
  updateConnectorActionResponseSchema;

export const listConnectorActionsResponseSchema = z.object({
  items: z.array(connectorActionRunSchema),
});

export const listConnectorActivityRequestSchema = z.object({
  kind: z.enum(["all", "sync", "action", "webhook"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export const listConnectorActivityResponseSchema = z.object({
  items: z.array(connectorActivityItemSchema),
  nextCursor: z.string().nullable(),
});

export const listConnectorWebhookEventsRequestSchema = z.object({
  connectorType: z.string().trim().min(1).optional(),
  connectorId: z.string().trim().min(1).optional(),
});

export const listConnectorWebhookEventsResponseSchema = z.object({
  items: z.array(connectorWebhookEventSchema),
});

export const connectorWebhookConfigResponseSchema = z.object({
  webhookUrl: z.string().url(),
  baseUrl: z.string().url(),
  connectorId: z.string().nullable(),
  connectorType: z.string().trim().min(1),
  isConfigured: z.boolean(),
  setupRequired: z.boolean(),
});

export const connectorNotionWriteRequestSchema = z.object({
  target: z.object({
    connectorId: z.string().trim().min(1).optional(),
    pageId: z.string().trim().min(1).optional(),
    pageTitle: z.string().trim().min(1).optional(),
    parentPageId: z.string().trim().min(1).optional(),
    dataSourceId: z.string().trim().min(1).optional(),
  }),
  title: z.string().trim().min(1).max(200).optional(),
  contentMarkdown: z.string().max(200_000).optional(),
  artifactId: z.string().trim().min(1).optional(),
  mode: z.enum(["create", "append", "update"]),
});

export const lookupNotionPagesRequestSchema = z.object({
  connectorId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  fuzzyTitle: z.string().trim().min(1).optional(),
  externalId: z.string().trim().min(1).optional(),
  externalUri: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export const lookupNotionPagesResponseSchema = z.object({
  items: z.array(
    z.object({
      sourceId: z.string(),
      connectorId: z.string().nullable(),
      title: z.string(),
      externalId: z.string().nullable(),
      externalUri: z.string().nullable(),
      status: z.string(),
      metadata: jsonObjectSchema,
      updatedAt: z.string(),
    }),
  ),
});

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export type ConnectorOAuthAccount = z.infer<typeof connectorOAuthAccountSchema>;
export type SourceConnector = z.infer<typeof sourceConnectorSchema>;
export type ConnectorSyncRun = z.infer<typeof connectorSyncRunSchema>;
export type ConnectorActionRun = z.infer<typeof connectorActionRunSchema>;
export type ConnectorActionVisibility = z.infer<
  typeof connectorActionVisibilitySchema
>;
export type ConnectorActionCapability = z.infer<
  typeof connectorActionCapabilitySchema
>;
export type ConnectorWebhookEvent = z.infer<typeof connectorWebhookEventSchema>;
export type ConnectorActivityItem = z.infer<typeof connectorActivityItemSchema>;
export type ConnectorNotionWriteRequest = z.infer<
  typeof connectorNotionWriteRequestSchema
>;
export type StartConnectorOAuthRequest = z.infer<
  typeof startConnectorOAuthRequestSchema
>;
export type StartConnectorOAuthResponse = z.infer<
  typeof startConnectorOAuthResponseSchema
>;
export type FinishConnectorOAuthResponse = z.infer<
  typeof finishConnectorOAuthResponseSchema
>;
export type ListConnectorOAuthAccountsRequest = z.infer<
  typeof listConnectorOAuthAccountsRequestSchema
>;
export type ListConnectorOAuthAccountsResponse = z.infer<
  typeof listConnectorOAuthAccountsResponseSchema
>;
export type CreateConnectorRequest = z.infer<
  typeof createConnectorRequestSchema
>;
export type CreateConnectorResponse = z.infer<
  typeof createConnectorResponseSchema
>;
export type UpdateConnectorRequest = z.infer<
  typeof updateConnectorRequestSchema
>;
export type UpdateConnectorResponse = z.infer<
  typeof updateConnectorResponseSchema
>;
export type DeleteConnectorRequest = z.infer<
  typeof deleteConnectorRequestSchema
>;
export type DeleteConnectorResponse = z.infer<
  typeof deleteConnectorResponseSchema
>;
export type DeleteConnectorAccountRequest = z.infer<
  typeof deleteConnectorAccountRequestSchema
>;
export type DeleteConnectorAccountResponse = z.infer<
  typeof deleteConnectorAccountResponseSchema
>;
export type ListConnectorsRequest = z.infer<typeof listConnectorsRequestSchema>;
export type ListConnectorsResponse = z.infer<
  typeof listConnectorsResponseSchema
>;
export type TriggerConnectorSyncResponse = z.infer<
  typeof triggerConnectorSyncResponseSchema
>;
export type ListConnectorSyncRunsResponse = z.infer<
  typeof listConnectorSyncRunsResponseSchema
>;
export type ListWorkspaceConnectorSyncRunsRequest = z.infer<
  typeof listWorkspaceConnectorSyncRunsRequestSchema
>;
export type ListWorkspaceConnectorSyncRunsResponse = z.infer<
  typeof listWorkspaceConnectorSyncRunsResponseSchema
>;
export type CreateConnectorActionRequest = z.infer<
  typeof createConnectorActionRequestSchema
>;
export type CreateConnectorActionResponse = z.infer<
  typeof createConnectorActionResponseSchema
>;
export type UpdateConnectorActionResponse = z.infer<
  typeof updateConnectorActionResponseSchema
>;
export type ExecuteConnectorActionResponse = z.infer<
  typeof executeConnectorActionResponseSchema
>;
export type ListConnectorManifestsResponse = z.infer<
  typeof listConnectorManifestsResponseSchema
>;
export type ListConnectorActionsResponse = z.infer<
  typeof listConnectorActionsResponseSchema
>;
export type ListConnectorActivityRequest = z.infer<
  typeof listConnectorActivityRequestSchema
>;
export type ListConnectorActivityResponse = z.infer<
  typeof listConnectorActivityResponseSchema
>;
export type ListConnectorWebhookEventsRequest = z.infer<
  typeof listConnectorWebhookEventsRequestSchema
>;
export type ListConnectorWebhookEventsResponse = z.infer<
  typeof listConnectorWebhookEventsResponseSchema
>;
export type ConnectorWebhookConfigResponse = z.infer<
  typeof connectorWebhookConfigResponseSchema
>;
export type LookupNotionPagesRequest = z.infer<
  typeof lookupNotionPagesRequestSchema
>;
export type LookupNotionPagesResponse = z.infer<
  typeof lookupNotionPagesResponseSchema
>;

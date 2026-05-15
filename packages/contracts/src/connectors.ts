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
]);

export const connectorActionRiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
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

const jsonObjectSchema = z.record(z.string(), z.unknown());

const connectorAuthManifestSchema = z.object({
  kind: z.literal("oauth2"),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1)),
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

export const createConnectorResponseSchema = z.object({
  connector: sourceConnectorSchema,
});

export const updateConnectorResponseSchema = z.object({
  connector: sourceConnectorSchema,
});

export const deleteConnectorResponseSchema = z.object({
  deleted: z.boolean(),
});

export const listConnectorsResponseSchema = z.object({
  items: z.array(sourceConnectorSchema),
});

export const triggerConnectorSyncResponseSchema = z.object({
  run: connectorSyncRunSchema,
  jobId: z.string().nullable(),
});

export const listConnectorSyncRunsResponseSchema = z.object({
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

export const listConnectorActionsResponseSchema = z.object({
  items: z.array(connectorActionRunSchema),
});

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export type ConnectorOAuthAccount = z.infer<typeof connectorOAuthAccountSchema>;
export type SourceConnector = z.infer<typeof sourceConnectorSchema>;
export type ConnectorSyncRun = z.infer<typeof connectorSyncRunSchema>;
export type ConnectorActionRun = z.infer<typeof connectorActionRunSchema>;

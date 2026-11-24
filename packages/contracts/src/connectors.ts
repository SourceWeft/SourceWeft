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
  "blocked",
]);

/**
 * Why a connector's syncs are paused by the platform rather than by the user.
 * Set when a run ends `blocked`, cleared when a later run gets past the block.
 */
export const connectorSyncBlockReasonSchema = z.enum([
  "PAGES_LIMIT_EXCEEDED",
  "CONNECTOR_BILLING_OWNER_UNAVAILABLE",
]);

export const connectorSyncBlockSchema = z.object({
  reason: connectorSyncBlockReasonSchema,
  runId: z.string(),
  blockedAt: z.string(),
  indexedCount: z.number().int().nonnegative(),
  requestedPages: z.number().int().nonnegative().nullable(),
  availablePages: z.number().int().nonnegative().nullable(),
  /** Last time the scheduler found the owner still without pages. */
  resumeCheckedAt: z.string().nullable().optional(),
});

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

const oauth2AuthManifestSchema = z.object({
  kind: z.literal("oauth2"),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1)),
  redirectUri: z.string().url().optional(),
  authorizationParams: z.record(z.string(), z.string()).optional(),
  sendScope: z.boolean().optional(),
});

/**
 * An adapter that brokers its own authorization (start, finish, revoke)
 * instead of running the platform's standard OAuth2 flow. `broker` names the
 * brokering integration (e.g. "composio"); the platform treats the resulting
 * credential as opaque. See `ConnectorAdapter.startAuthorization` /
 * `finishAuthorization` / `revokeAuthorization`.
 */
const brokeredAuthManifestSchema = z.object({
  kind: z.literal("brokered"),
  broker: z.string().min(1),
  scopes: z.array(z.string().min(1)),
});

/**
 * A connector that needs no account authorization (e.g. a public feed). It
 * has no OAuth exchange or refresh; its source is read with the connector's
 * own configuration alone.
 */
const noneAuthManifestSchema = z.object({
  kind: z.literal("none"),
});

/**
 * A connector authorized by a username and secret the member enters directly
 * (e.g. WebDAV Basic auth), stored as an encrypted account. It has no OAuth
 * exchange or refresh. `scheme` names how the credential is presented.
 */
const credentialAuthManifestSchema = z.object({
  kind: z.literal("credential"),
  scheme: z.literal("basic"),
});

const connectorAuthManifestSchema = z.discriminatedUnion("kind", [
  oauth2AuthManifestSchema,
  brokeredAuthManifestSchema,
  noneAuthManifestSchema,
  credentialAuthManifestSchema,
]);

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
  requestPrivacy: z.enum(["plain", "encrypted"]).optional(),
  allowStandingApproval: z.boolean().optional(),
  inputSchema: jsonObjectSchema,
  agentToolName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  visibility: connectorActionVisibilitySchema.optional(),
  capabilities: z.array(connectorActionCapabilitySchema).optional(),
});

// ---------------------------------------------------------------------------
// Selection contract — browse, search and describe over a connector's items
// ---------------------------------------------------------------------------
//
// Bounds enforced here mirror the equivalent, independently-defined rules in
// `packages/capability-contracts/src/index.ts` (`connectorContributionSchema`);
// the two packages have no dependency on each other, so the field-level rules
// are duplicated on purpose. Only the cross-check against a contribution's
// declared actions lives on the capability-contracts side.

// Kinds, disabled-reason codes and help-link codes become i18n key segments
// (`…kinds.<kind>`, `…disabledReason.<code>`, `…helpLink.<code>`), so a dot or
// any other separator would walk the message tree. Restrict them to lowercase
// word characters. Existing values (`folder`, `file`, `unsupported`) satisfy it.
const SELECTION_KEY_SEGMENT = /^[a-z0-9_]+$/;

export const connectorSelectionKindSchema = z
  .string()
  .max(64)
  .regex(SELECTION_KEY_SEGMENT);

export const connectorSelectionItemSchema = z.object({
  id: z.string().min(1).max(512),
  kind: connectorSelectionKindSchema,
});

export const connectorSelectionSpecSchema = z.object({
  actions: z.object({
    browse: z.string().min(1),
    search: z.string().min(1).optional(),
    describe: z.string().min(1),
  }),
  kinds: z
    .array(connectorSelectionKindSchema)
    .min(1)
    .max(20)
    .superRefine((kinds, context) => {
      const seen = new Set<string>();
      kinds.forEach((kind, index) => {
        if (seen.has(kind)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate kind '${kind}'`,
            path: [index],
          });
        }
        seen.add(kind);
      });
    }),
  maxItems: z.number().int().min(1).max(500),
});

const connectorSelectionContainerSchema = z.object({
  id: z.string().min(1).max(512),
  kind: connectorSelectionKindSchema,
  name: z.string().max(1024),
  detail: z.string().max(2048).nullable(),
});

const connectorSelectionBreadcrumbSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().max(1024),
});

export const connectorSelectionEntrySchema = z.object({
  id: z.string().min(1).max(512),
  kind: connectorSelectionKindSchema,
  name: z.string().max(1024),
  detail: z.string().max(2048).nullable(),
  selectable: z.boolean(),
  expandable: z.boolean(),
  disabledReason: z
    .string()
    .max(64)
    .regex(SELECTION_KEY_SEGMENT)
    .nullable(),
  size: z.number().finite().nonnegative().nullable(),
  modifiedAt: z.string().max(64).nullable(),
});

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const connectorSelectionHelpLinkSchema = z.object({
  code: z.string().max(64).regex(SELECTION_KEY_SEGMENT),
  url: z
    .string()
    .max(2048)
    .refine(isHttpsUrl, "helpLink.url must be an https:// URL"),
});

export const connectorSelectionBrowseResultSchema = z.object({
  container: connectorSelectionContainerSchema.nullable(),
  breadcrumbs: z.array(connectorSelectionBreadcrumbSchema).max(50),
  entries: z.array(connectorSelectionEntrySchema).max(500),
  cursor: z.string().max(4096),
  hasMore: z.boolean(),
  helpLink: connectorSelectionHelpLinkSchema.nullable().default(null),
});

export const connectorSelectionSearchResultSchema = z.object({
  entries: z.array(connectorSelectionEntrySchema).max(500),
  cursor: z.string().max(4096),
  hasMore: z.boolean(),
});

export const connectorSelectionDescribeItemSchema = z.object({
  id: z.string().min(1).max(512),
  kind: connectorSelectionKindSchema.nullable(),
  name: z.string().max(1024).nullable(),
  detail: z.string().max(2048).nullable(),
  exists: z.boolean(),
  meta: z
    .record(z.string(), z.union([z.string().max(2048), z.number(), z.null()]))
    .refine(
      (meta) => Object.keys(meta).length <= 20,
      "meta must have at most 20 keys",
    )
    .default({}),
});

export const connectorSelectionDescribeResultSchema = z.object({
  items: z.array(connectorSelectionDescribeItemSchema).max(100),
});

export const connectorManifestSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  auth: connectorAuthManifestSchema,
  sync: z.object({
    supportsIncremental: z.boolean(),
    defaultFrequencyMinutes: z.number().int().positive(),
    minFrequencyMinutes: z.number().int().positive().optional(),
    resources: z.array(connectorResourceSpecSchema),
  }),
  actions: z.array(connectorActionSpecSchema),
  configSchema: jsonObjectSchema,
  selection: connectorSelectionSpecSchema.optional(),
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
  scheduleStatus: z
    .object({
      enabled: z.boolean(),
      nextDueAt: z.string().nullable(),
      retryAt: z.string().nullable(),
      lastAttemptAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastErrorCode: z.string().nullable(),
    })
    .nullable()
    .optional(),
  syncBlock: connectorSyncBlockSchema.nullable().optional(),
  lastError: z.string().nullable(),
  // Present only for `credential`-kind connectors. `credentialConfigured` is
  // whether an active stored credential account backs the connector;
  // `credentialDisplayName` is that account's non-secret display name (the
  // username). The secret itself is never exposed.
  credentialConfigured: z.boolean().optional(),
  credentialDisplayName: z.string().nullable().optional(),
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

/**
 * A username and secret entered for a `credential` connector. Trimming applies
 * to the username only; the secret is kept exactly as typed. Neither value is
 * ever returned by the API.
 */
export const connectorCredentialInputSchema = z.object({
  username: z.string().trim().min(1).max(200),
  secret: z.string().min(1).max(2000),
});
export type ConnectorCredentialInput = z.infer<
  typeof connectorCredentialInputSchema
>;

export const rotateConnectorCredentialRequestSchema =
  connectorCredentialInputSchema;
export type RotateConnectorCredentialRequest = z.infer<
  typeof rotateConnectorCredentialRequestSchema
>;

export const connectorCredentialStatusSchema = z.object({
  credentialConfigured: z.boolean(),
  displayName: z.string().nullable(),
});
export type ConnectorCredentialStatus = z.infer<
  typeof connectorCredentialStatusSchema
>;

export const createConnectorRequestSchema = z.object({
  connectorType: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  oauthAccountId: z.string().trim().min(1).optional(),
  configJson: jsonObjectSchema.optional(),
  periodicIndexingEnabled: z.boolean().optional(),
  indexingFrequencyMinutes: z.number().int().positive().optional(),
  credential: connectorCredentialInputSchema.optional(),
});

export const checkConnectorConfigRequestSchema = z.object({
  connectorType: z.string().trim().min(1),
  configJson: jsonObjectSchema,
  credential: connectorCredentialInputSchema.optional(),
});

export const checkConnectorConfigResponseSchema = z.object({
  ready: z.boolean(),
  reason: z.string().optional(),
  message: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
});

export const updateConnectorRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  oauthAccountId: z.string().trim().min(1).optional(),
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

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export type ConnectorSelectionItem = z.infer<
  typeof connectorSelectionItemSchema
>;
export type ConnectorSelectionSpec = z.infer<
  typeof connectorSelectionSpecSchema
>;
export type ConnectorSelectionEntry = z.infer<
  typeof connectorSelectionEntrySchema
>;
export type ConnectorSelectionBrowseResult = z.infer<
  typeof connectorSelectionBrowseResultSchema
>;
export type ConnectorSelectionSearchResult = z.infer<
  typeof connectorSelectionSearchResultSchema
>;
export type ConnectorSelectionDescribeItem = z.infer<
  typeof connectorSelectionDescribeItemSchema
>;
export type ConnectorSelectionDescribeResult = z.infer<
  typeof connectorSelectionDescribeResultSchema
>;
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
export type ConnectorActionRiskLevel = z.infer<
  typeof connectorActionRiskLevelSchema
>;
export type ConnectorActionRunStatus = z.infer<
  typeof connectorActionRunStatusSchema
>;
export type ConnectorOAuthAccountStatus = z.infer<
  typeof connectorOAuthAccountStatusSchema
>;
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export type ConnectorSyncRunTriggerType = z.infer<
  typeof connectorSyncRunTriggerTypeSchema
>;
export type ConnectorSyncBlock = z.infer<typeof connectorSyncBlockSchema>;
export type ConnectorSyncBlockReason = z.infer<
  typeof connectorSyncBlockReasonSchema
>;
export type ConnectorSyncRunStatus = z.infer<
  typeof connectorSyncRunStatusSchema
>;
export type ConnectorWebhookEventStatus = z.infer<
  typeof connectorWebhookEventStatusSchema
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
export type CheckConnectorConfigRequest = z.infer<
  typeof checkConnectorConfigRequestSchema
>;
export type CheckConnectorConfigResponse = z.infer<
  typeof checkConnectorConfigResponseSchema
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

// ---------------------------------------------------------------------------
// Runtime adapter interface — implemented by connector packages
// ---------------------------------------------------------------------------

export type ConnectorType = string;

export type ConnectorItem = {
  externalId: string;
  externalUri: string | null;
  title: string;
  /** An adapter that returns file-shaped content must set `mimeType` on the
   * discovered item, because an unchanged scan writes it straight to the source
   * without re-extracting. */
  mimeType: string | null;
  sizeBytes: number | null;
  externalUpdatedAt: Date | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
};

export type ConnectorDirectoryNode = {
  externalId: string;
  title: string;
  externalUri?: string | null;
  metadata?: Record<string, unknown>;
};

export type ConnectorDiscoverInput = {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: ConnectorType;
  connectorName?: string;
  config: Record<string, unknown>;
  accessToken: string;
  cursor?: Record<string, unknown> | null;
};

/** A durable discovery page. The continuation is replayed until every item
 * in the page has been applied. The committed checkpoint advances only on the
 * final page of a complete provider change range. */
export type ConnectorDiscoveryPage = {
  items: ConnectorItem[];
  deletedExternalIds?: string[];
  continuation?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  complete: boolean;
  /** True only for a complete authoritative scan of the selected scope. */
  reconcileMissing?: boolean;
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
  rawResponseJson?: unknown;
  result: Record<string, unknown>;
  shouldResync?: boolean;
  resyncExternalIds?: string[];
};

export type ConnectorExtractedFileDescriptor = {
  /** `fileName` and `mimeType` drive classification: they decide the file kind
   * and the parser branch before any bytes are downloaded, so an adapter must
   * report the real name and type it discovered. */
  fileName: string;
  mimeType: string;
  /** Known size in bytes, or `null` for "unknown, check after download" — the
   * resolver re-checks the downloaded length against the cap when this is null. */
  sizeBytes: number | null;
  /** Must throw `ConnectorItemSkipError("too_large")` rather than truncate when
   * the content exceeds `maxBytes`. */
  download(input: { maxBytes: number }): Promise<Buffer>;
};

export type ConnectorExtractedText = {
  item: ConnectorItem;
  contentText: string;
  markdown?: string;
  parentExternalId?: string | null;
  directoryPath?: ConnectorDirectoryNode[];
};

export type ConnectorExtractedFile = {
  item: ConnectorItem;
  file: ConnectorExtractedFileDescriptor;
  parentExternalId?: string | null;
  directoryPath?: ConnectorDirectoryNode[];
};

export type ConnectorExtractedContent =
  | ConnectorExtractedText
  | ConnectorExtractedFile;

export function isConnectorExtractedFile(
  value: ConnectorExtractedContent,
): value is ConnectorExtractedFile {
  return (value as ConnectorExtractedFile).file !== undefined;
}

export const connectorItemSkipReasons = [
  "unsupported_type",
  "too_large",
  "needs_ocr",
  "export_too_large",
  "empty_content",
  "unreadable",
] as const;

export type ConnectorItemSkipReason = (typeof connectorItemSkipReasons)[number];

export class ConnectorItemSkipError extends Error {
  readonly code = "CONNECTOR_ITEM_SKIPPED";

  constructor(readonly reason: ConnectorItemSkipReason) {
    super(`Connector item skipped: ${reason}`);
    this.name = "ConnectorItemSkipError";
  }
}

export function isConnectorItemSkipError(
  error: unknown,
): error is ConnectorItemSkipError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "CONNECTOR_ITEM_SKIPPED" &&
    connectorItemSkipReasons.includes(
      (error as { reason?: unknown }).reason as ConnectorItemSkipReason,
    )
  );
}

/**
 * One entry of a sync run's `metadataJson.skippedItems`, as written by the sync
 * orchestrator. `reason` is kept as a plain string rather than the
 * {@link connectorItemSkipReasons} enum so a reader stays forward-compatible:
 * an unrecognised reason is preserved and the UI maps it to an "unknown"
 * message instead of being dropped. `title` is the item title the run recorded,
 * which may be absent for a malformed record and is then normalised to `null`.
 */
export const connectorSkippedItemSchema = z.object({
  externalId: z.string().min(1),
  title: z.string().nullable().catch(null),
  reason: z.string().min(1),
});

export type ConnectorSkippedItem = z.infer<typeof connectorSkippedItemSchema>;

/**
 * Read the skipped items from unknown connector sync-run metadata, tolerating
 * anything a future or faulty producer might write: a non-object, a missing or
 * non-array `skippedItems`, and individual malformed entries are all handled by
 * returning (or skipping to) nothing rather than throwing. Entries that lack an
 * `externalId` or `reason` are dropped; entries with an unknown `reason` string
 * are kept so the UI can surface them under its "unknown" message.
 */
export function readConnectorSkippedItems(
  metadata: unknown,
): ConnectorSkippedItem[] {
  const container = z
    .object({ skippedItems: z.array(z.unknown()) })
    .safeParse(metadata);
  if (!container.success) {
    return [];
  }
  const items: ConnectorSkippedItem[] = [];
  for (const entry of container.data.skippedItems) {
    const parsed = connectorSkippedItemSchema.safeParse(entry);
    if (parsed.success) {
      items.push(parsed.data);
    }
  }
  return items;
}

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
  /**
   * Opaque credential for this account. For a standard OAuth2 adapter this is
   * the provider's access token; for a brokered adapter it is whatever
   * opaque reference the broker hands back. Either way the platform stores
   * it encrypted and returns it only to the adapter that produced it.
   */
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  providerAccountId?: string | null;
  providerAccountEmail?: string | null;
  displayName?: string | null;
};

export type ConnectorWebhookVerifyInput = {
  headers: Record<string, string>;
  rawBody: string;
  query: Record<string, string | undefined>;
};

/** Parsed webhook event from a connector adapter (distinct from ConnectorWebhookEvent DB record). */
export type ConnectorWebhookPayload = {
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
  "sync" | "archive_source" | "record_only";

export type ConnectorWebhookTarget = {
  action: ConnectorWebhookTargetAction;
  externalId?: string | null;
  objectId?: string | null;
  objectType?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type ConnectorSyncReadinessResult = {
  ready: boolean;
  reason?: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type ConnectorActionSpec = z.infer<typeof connectorActionSpecSchema>;
export type ConnectorResourceSpec = z.infer<typeof connectorResourceSpecSchema>;

export type ConnectorAuthorizationStartInput = {
  callbackUrl: string;
  ownerRef: string;
};

export type ConnectorAuthorizationStartResult = {
  authorizationUrl: string;
  attemptRef: string;
};

export type ConnectorAuthorizationFinishInput = {
  callbackParams: Record<string, string>;
  attemptRef: string;
  ownerRef: string;
};

/** One stored provider account and when its personal data was last refreshed. */
export type ConnectorPersonalDataAccount = { accountId: string; updatedAt: Date };

export type ConnectorPersonalDataReport = {
  /** Account ids the provider reports as closed; only ids that were sent. */
  closed: string[];
  /** Account ids the provider reports as changed; only ids that were sent. */
  updated: string[];
  /** Provider answer entries that were dropped (not sent, unknown, duplicate). */
  ignored: number;
  /** The provider's requested reporting cycle in days, or `null` when unknown. */
  cyclePeriodDays: number | null;
};

/** The identity fields a provider stores for an account. */
export type ConnectorAccountProfile = {
  providerAccountId: string;
  email: string | null;
  displayName: string;
};

/**
 * Optional provider personal-data obligations (reporting stored accounts and
 * re-reading their identity), implemented by providers whose terms require it.
 */
export interface ConnectorPersonalDataSupport {
  /** At most 90 accounts per call. */
  report(input: {
    accessToken: string;
    accounts: ConnectorPersonalDataAccount[];
  }): Promise<ConnectorPersonalDataReport>;
  /** Re-reads the identity fields the platform stores for an account. */
  readProfile(input: { accessToken: string }): Promise<ConnectorAccountProfile>;
}

export interface ConnectorAdapter {
  capabilityId?: string;
  getManifest(): ConnectorManifest;
  /** Standard OAuth2 only; absent on `none` and brokered adapters. */
  exchangeOAuthCode?(input: OAuthCodeExchangeInput): Promise<OAuthTokenSet>;
  /** Standard OAuth2 only; absent on `none` and brokered adapters. */
  refreshOAuthToken?(input: OAuthRefreshInput): Promise<OAuthTokenSet>;
  /**
   * Brokered auth only: start a broker-hosted authorization attempt and
   * return the URL to send the owner to.
   */
  startAuthorization?(
    input: ConnectorAuthorizationStartInput,
  ): Promise<ConnectorAuthorizationStartResult>;
  /**
   * Brokered auth only: complete a broker-hosted authorization attempt and
   * return the resulting opaque credential. The adapter is responsible for
   * verifying the callback against `attemptRef` (that the broker reports the
   * same attempt it started, and succeeded); the platform does not inspect
   * `callbackParams` and only passes through the `attemptRef` it stored.
   */
  finishAuthorization?(
    input: ConnectorAuthorizationFinishInput,
  ): Promise<OAuthTokenSet>;
  /** Brokered auth only: revoke a previously brokered credential. */
  revokeAuthorization?(input: { accessToken: string }): Promise<void>;
  /**
   * Credential auth only: derive a stable, non-secret account identity from the
   * connector's config and the entered credential (e.g.
   * `sha256(origin + "\n" + username)`). Stored as the account's
   * `providerAccountId` so the same endpoint and user cannot be attached twice
   * in one workspace. Required for a `credential` connector; absent on every
   * other kind. Must never embed the secret in its return value.
   */
  credentialIdentity?(
    config: Record<string, unknown>,
    credential: ConnectorCredentialInput,
  ): string;
  checkSyncReadiness?(
    input: ConnectorDiscoverInput,
  ): Promise<ConnectorSyncReadinessResult>;
  discover(input: ConnectorDiscoverInput): AsyncIterable<ConnectorItem>;
  /** Optional until existing full-scan adapters migrate to durable paging. */
  discoverPages?(
    input: ConnectorDiscoverInput,
  ): AsyncIterable<ConnectorDiscoveryPage>;
  extract(input: ConnectorExtractInput): Promise<ConnectorExtractedContent>;
  executeAction(input: ConnectorActionInput): Promise<ConnectorActionResult>;
  /** Present on providers with personal-data reporting obligations. */
  personalData?: ConnectorPersonalDataSupport;
  verifyWebhook?(input: ConnectorWebhookVerifyInput): Promise<void>;
  parseWebhookEvent?(
    input: ConnectorWebhookVerifyInput,
  ): Promise<ConnectorWebhookPayload>;
  mapWebhookEventToSyncTargets?(
    event: ConnectorWebhookPayload,
  ): Promise<ConnectorWebhookTarget[]>;
}

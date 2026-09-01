import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";

type ConnectorStatus = "active" | "paused" | "error" | "disabled";
type ConnectorOAuthAccountStatus =
  "active" | "reauth_required" | "revoked" | "disabled";
type SyncRunTriggerType = "manual" | "scheduled" | "webhook" | "backfill";
type SyncRunStatus =
  "queued" | "running" | "succeeded" | "failed" | "canceled" | "skipped";
type ConnectorActionRiskLevel = "low" | "medium" | "high";
type ConnectorActionRunStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
type ConnectorWebhookEventStatus =
  "received" | "queued" | "processed" | "ignored" | "failed";
type AgentToolTrustRuleStatus = "active" | "revoked";
type McpTransport = "streamable_http" | "http_sse_compat" | "sse" | "stdio";
type McpAuthType =
  "none" | "bearer" | "api_key_header" | "custom_headers" | "oauth";
type McpRiskLevel = "read" | "write" | "destructive" | "unknown";
type WorkspaceMcpInstallStatus = "active" | "disabled" | "error";
type WorkspaceMcpCredentialStatus =
  "not_required" | "required" | "configured" | "invalid";
type McpInstallSource = "market" | "custom" | "local_import";
type McpActionRunStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export const connectorOAuthAccounts = pgTable(
  "connector_oauth_accounts",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectorType: text("connector_type").notNull(),
    providerAccountId: text("provider_account_id"),
    providerAccountEmail: text("provider_account_email"),
    displayName: text("display_name").notNull(),
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    status: text("status")
      .$type<ConnectorOAuthAccountStatus>()
      .notNull()
      .default("active"),
    lastRefreshAt: timestamp("last_refresh_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastError: text("last_error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connector_oauth_accounts_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    unique("connector_oauth_accounts_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "connector_oauth_accounts_status_check",
      sql`${table.status} in ('active', 'reauth_required', 'revoked', 'disabled')`,
    ),
    check(
      "connector_oauth_accounts_scopes_array_check",
      sql`jsonb_typeof(${table.scopes}) = 'array'`,
    ),
    index("connector_oauth_accounts_workspace_type_status_idx").on(
      table.workspaceId,
      table.connectorType,
      table.status,
    ),
    index("connector_oauth_accounts_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);

export const connectorOAuthStates = pgTable(
  "connector_oauth_states",
  {
    id: text("id").primaryKey(),
    stateHash: text("state_hash").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    connectorType: text("connector_type").notNull(),
    redirectAfter: text("redirect_after"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connector_oauth_states_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("connector_oauth_states_state_hash_uq").on(table.stateHash),
    index("connector_oauth_states_workspace_user_created_idx").on(
      table.workspaceId,
      table.userId,
      desc(table.createdAt),
    ),
    index("connector_oauth_states_expires_idx").on(table.expiresAt),
  ],
);

export const sourceConnectors = pgTable(
  "source_connectors",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectorType: text("connector_type").notNull(),
    name: text("name").notNull(),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    secretRef: text("secret_ref"),
    oauthAccountId: text("oauth_account_id").references(
      () => connectorOAuthAccounts.id,
      { onDelete: "restrict" },
    ),
    status: text("status").$type<ConnectorStatus>().notNull().default("active"),
    periodicIndexingEnabled: boolean("periodic_indexing_enabled")
      .notNull()
      .default(false),
    indexingFrequencyMinutes: integer("indexing_frequency_minutes"),
    lastIndexedAt: timestamp("last_indexed_at", {
      withTimezone: true,
      mode: "date",
    }),
    nextScheduledAt: timestamp("next_scheduled_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastError: text("last_error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "source_connectors_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "source_connectors_oauth_account_workspace_team_fk",
      columns: [table.oauthAccountId, table.workspaceId, table.teamId],
      foreignColumns: [
        connectorOAuthAccounts.id,
        connectorOAuthAccounts.workspaceId,
        connectorOAuthAccounts.teamId,
      ],
    }).onDelete("restrict"),
    unique("source_connectors_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "source_connectors_status_check",
      sql`${table.status} in ('active', 'paused', 'error', 'disabled')`,
    ),
    check(
      "source_connectors_indexing_frequency_check",
      sql`${table.indexingFrequencyMinutes} is null or ${table.indexingFrequencyMinutes} > 0`,
    ),
    uniqueIndex("source_connectors_workspace_type_name_uq").on(
      table.workspaceId,
      table.connectorType,
      table.name,
    ),
    uniqueIndex("source_connectors_oauth_account_uq")
      .on(table.oauthAccountId)
      .where(sql`${table.oauthAccountId} is not null`),
    index("source_connectors_team_workspace_status_next_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
      table.nextScheduledAt,
    ),
    index("source_connectors_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);

export const connectorActionRuns = pgTable(
  "connector_action_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => sourceConnectors.id, { onDelete: "cascade" }),
    connectorType: text("connector_type").notNull(),
    actionType: text("action_type").notNull(),
    agentToolName: text("agent_tool_name"),
    riskLevel: text("risk_level").$type<ConnectorActionRiskLevel>().notNull(),
    status: text("status").$type<ConnectorActionRunStatus>().notNull(),
    requestJson: jsonb("request_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    requestPreview: text("request_preview").notNull(),
    resultJson: jsonb("result_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    externalId: text("external_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    approvedBy: text("approved_by"),
    executedBy: text("executed_by"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connector_action_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "connector_action_runs_connector_workspace_team_fk",
      columns: [table.connectorId, table.workspaceId, table.teamId],
      foreignColumns: [
        sourceConnectors.id,
        sourceConnectors.workspaceId,
        sourceConnectors.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "connector_action_runs_risk_level_check",
      sql`${table.riskLevel} in ('low', 'medium', 'high')`,
    ),
    check(
      "connector_action_runs_status_check",
      sql`${table.status} in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    index("connector_action_runs_connector_created_idx").on(
      table.connectorId,
      desc(table.createdAt),
    ),
    index("connector_action_runs_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
    uniqueIndex("connector_action_runs_idempotency_uq").on(
      table.workspaceId,
      table.connectorId,
      table.idempotencyKey,
    ),
  ],
);

export const connectorSyncRuns = pgTable(
  "connector_sync_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => sourceConnectors.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").$type<SyncRunTriggerType>().notNull(),
    status: text("status").$type<SyncRunStatus>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", {
      withTimezone: true,
      mode: "date",
    }),
    discoveredCount: integer("discovered_count").notNull().default(0),
    indexedCount: integer("indexed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connector_sync_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "connector_sync_runs_connector_workspace_team_fk",
      columns: [table.connectorId, table.workspaceId, table.teamId],
      foreignColumns: [
        sourceConnectors.id,
        sourceConnectors.workspaceId,
        sourceConnectors.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "connector_sync_runs_trigger_type_check",
      sql`${table.triggerType} in ('manual', 'scheduled', 'webhook', 'backfill')`,
    ),
    check(
      "connector_sync_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled', 'skipped')`,
    ),
    check(
      "connector_sync_runs_discovered_count_check",
      sql`${table.discoveredCount} >= 0`,
    ),
    check(
      "connector_sync_runs_indexed_count_check",
      sql`${table.indexedCount} >= 0`,
    ),
    check(
      "connector_sync_runs_failed_count_check",
      sql`${table.failedCount} >= 0`,
    ),
    index("connector_sync_runs_connector_created_idx").on(
      table.connectorId,
      desc(table.createdAt),
    ),
    index("connector_sync_runs_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
  ],
);

export const agentToolTrustRules = pgTable(
  "agent_tool_trust_rules",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    domain: text("domain").notNull(),
    toolName: text("tool_name").notNull(),
    connectorId: text("connector_id").references(() => sourceConnectors.id, {
      onDelete: "cascade",
    }),
    targetType: text("target_type"),
    targetId: text("target_id"),
    allowedRiskLevels: jsonb("allowed_risk_levels")
      .$type<ConnectorActionRiskLevel[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").$type<AgentToolTrustRuleStatus>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdFromConfirmationId: text("created_from_confirmation_id"),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_tool_trust_rules_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_tool_trust_rules_connector_workspace_team_fk",
      columns: [table.connectorId, table.workspaceId, table.teamId],
      foreignColumns: [
        sourceConnectors.id,
        sourceConnectors.workspaceId,
        sourceConnectors.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "agent_tool_trust_rules_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    index("agent_tool_trust_rules_scope_idx").on(
      table.workspaceId,
      table.userId,
      table.domain,
      table.toolName,
      table.status,
    ),
    index("agent_tool_trust_rules_connector_idx").on(table.connectorId),
  ],
);

export const workspaceMcpInstalls = pgTable(
  "workspace_mcp_installs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source")
      .$type<McpInstallSource>()
      .notNull()
      .default("market"),
    marketIdentifier: text("market_identifier"),
    marketVersion: text("market_version"),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    transport: text("transport").$type<McpTransport>().notNull(),
    endpointUrl: text("endpoint_url"),
    status: text("status")
      .$type<WorkspaceMcpInstallStatus>()
      .notNull()
      .default("active"),
    official: boolean("official").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    desktopOnly: boolean("desktop_only").notNull().default(false),
    webExecutable: boolean("web_executable").notNull().default(true),
    authType: text("auth_type").$type<McpAuthType>().notNull().default("none"),
    credentialStatus: text("credential_status")
      .$type<WorkspaceMcpCredentialStatus>()
      .notNull()
      .default("not_required"),
    enabled: boolean("enabled").notNull().default(true),
    manifestJson: jsonb("manifest_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    signature: text("signature"),
    signingKeyId: text("signing_key_id"),
    lastTestedAt: timestamp("last_tested_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastError: text("last_error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_mcp_installs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "workspace_mcp_installs_source_check",
      sql`${table.source} in ('market', 'custom', 'local_import')`,
    ),
    check(
      "workspace_mcp_installs_transport_check",
      sql`${table.transport} in ('streamable_http', 'http_sse_compat', 'sse', 'stdio')`,
    ),
    check(
      "workspace_mcp_installs_status_check",
      sql`${table.status} in ('active', 'disabled', 'error')`,
    ),
    check(
      "workspace_mcp_installs_auth_type_check",
      sql`${table.authType} in ('none', 'bearer', 'api_key_header', 'custom_headers', 'oauth')`,
    ),
    check(
      "workspace_mcp_installs_credential_status_check",
      sql`${table.credentialStatus} in ('not_required', 'required', 'configured', 'invalid')`,
    ),
    uniqueIndex("workspace_mcp_installs_market_uq")
      .on(table.workspaceId, table.marketIdentifier)
      .where(sql`${table.marketIdentifier} is not null`),
    unique("workspace_mcp_installs_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    index("workspace_mcp_installs_workspace_status_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
    ),
  ],
);

export const workspaceMcpTools = pgTable(
  "workspace_mcp_tools",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installId: text("install_id")
      .notNull()
      .references(() => workspaceMcpInstalls.id, { onDelete: "cascade" }),
    serverToolName: text("server_tool_name").notNull(),
    normalizedToolName: text("normalized_tool_name").notNull(),
    title: text("title"),
    description: text("description"),
    inputSchema: jsonb("input_schema")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    outputSchema: jsonb("output_schema").$type<Record<
      string,
      unknown
    > | null>(),
    annotations: jsonb("annotations")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    risk: text("risk").$type<McpRiskLevel>().notNull().default("unknown"),
    enabled: boolean("enabled").notNull().default(true),
    lastDiscoveredHash: text("last_discovered_hash"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_mcp_tools_install_workspace_team_fk",
      columns: [table.installId, table.workspaceId, table.teamId],
      foreignColumns: [
        workspaceMcpInstalls.id,
        workspaceMcpInstalls.workspaceId,
        workspaceMcpInstalls.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "workspace_mcp_tools_risk_check",
      sql`${table.risk} in ('read', 'write', 'destructive', 'unknown')`,
    ),
    uniqueIndex("workspace_mcp_tools_install_tool_uq").on(
      table.installId,
      table.serverToolName,
    ),
    uniqueIndex("workspace_mcp_tools_workspace_normalized_uq").on(
      table.workspaceId,
      table.normalizedToolName,
    ),
    index("workspace_mcp_tools_install_enabled_idx").on(
      table.installId,
      table.enabled,
    ),
  ],
);

export const workspaceMcpCredentials = pgTable(
  "workspace_mcp_credentials",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installId: text("install_id")
      .notNull()
      .references(() => workspaceMcpInstalls.id, { onDelete: "cascade" }),
    // Static (non-OAuth) MCP credentials are per-user, mirroring the OAuth
    // sessions table: on a shared workspace/thread one member's bearer token or
    // API key must never be usable by another member's turn. Keyed by
    // (installId, userId); the connection is skipped when the invoking user has
    // no credential of their own.
    userId: text("user_id").notNull(),
    authType: text("auth_type").$type<McpAuthType>().notNull(),
    encryptedSecret: text("encrypted_secret"),
    encryptedHeaders: text("encrypted_headers"),
    headerName: text("header_name"),
    status: text("status")
      .$type<WorkspaceMcpCredentialStatus>()
      .notNull()
      .default("configured"),
    configuredBy: text("configured_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_mcp_credentials_install_workspace_team_fk",
      columns: [table.installId, table.workspaceId, table.teamId],
      foreignColumns: [
        workspaceMcpInstalls.id,
        workspaceMcpInstalls.workspaceId,
        workspaceMcpInstalls.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "workspace_mcp_credentials_auth_type_check",
      sql`${table.authType} in ('none', 'bearer', 'api_key_header', 'custom_headers', 'oauth')`,
    ),
    check(
      "workspace_mcp_credentials_status_check",
      sql`${table.status} in ('not_required', 'required', 'configured', 'invalid')`,
    ),
    uniqueIndex("workspace_mcp_credentials_install_user_uq").on(
      table.installId,
      table.userId,
    ),
  ],
);

/**
 * Per-(install, user) OAuth session for MCP servers using authType "oauth".
 * Holds the authorization-server issuer we bound to, the DCR-registered client
 * (when the server supports Dynamic Client Registration; encrypted), the user's
 * encrypted access/refresh tokens, and the short-lived PKCE verifier + state
 * spanning an authorize→callback round-trip. Tokens are per-user; confidential
 * app client_id/secret for non-DCR providers live in env, never here.
 */
export const workspaceMcpOAuthSessions = pgTable(
  "workspace_mcp_oauth_sessions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installId: text("install_id")
      .notNull()
      .references(() => workspaceMcpInstalls.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    issuer: text("issuer"),
    // Encrypted JSON of the DCR-registered client { client_id, client_secret? }.
    encryptedClientInfo: text("encrypted_client_info"),
    // Encrypted JSON of the OAuth tokens { access_token, refresh_token?, ... }.
    encryptedTokens: text("encrypted_tokens"),
    // Transient, single-use across the authorize→callback window.
    codeVerifier: text("code_verifier"),
    state: text("state"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_mcp_oauth_sessions_install_workspace_team_fk",
      columns: [table.installId, table.workspaceId, table.teamId],
      foreignColumns: [
        workspaceMcpInstalls.id,
        workspaceMcpInstalls.workspaceId,
        workspaceMcpInstalls.teamId,
      ],
    }).onDelete("cascade"),
    uniqueIndex("workspace_mcp_oauth_sessions_install_user_uq").on(
      table.installId,
      table.userId,
    ),
  ],
);

export const mcpToolRuns = pgTable(
  "mcp_tool_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    installId: text("install_id").references(() => workspaceMcpInstalls.id, {
      onDelete: "set null",
    }),
    toolId: text("tool_id").references(() => workspaceMcpTools.id, {
      onDelete: "set null",
    }),
    actionRunId: text("action_run_id"),
    serverToolName: text("server_tool_name").notNull(),
    normalizedToolName: text("normalized_tool_name").notNull(),
    risk: text("risk").$type<McpRiskLevel>().notNull().default("unknown"),
    status: text("status").notNull(),
    redactedInput: jsonb("redacted_input")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    redactedOutput: jsonb("redacted_output")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "mcp_tool_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "mcp_tool_runs_risk_check",
      sql`${table.risk} in ('read', 'write', 'destructive', 'unknown')`,
    ),
    check(
      "mcp_tool_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'proposed', 'rejected', 'canceled')`,
    ),
    index("mcp_tool_runs_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    index("mcp_tool_runs_install_created_idx").on(
      table.installId,
      desc(table.createdAt),
    ),
  ],
);

export const mcpActionRuns = pgTable(
  "mcp_action_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installId: text("install_id")
      .notNull()
      .references(() => workspaceMcpInstalls.id, { onDelete: "cascade" }),
    toolId: text("tool_id").references(() => workspaceMcpTools.id, {
      onDelete: "set null",
    }),
    serverToolName: text("server_tool_name").notNull(),
    normalizedToolName: text("normalized_tool_name").notNull(),
    risk: text("risk").$type<McpRiskLevel>().notNull().default("unknown"),
    status: text("status").$type<McpActionRunStatus>().notNull(),
    requestJson: jsonb("request_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    requestPreview: text("request_preview").notNull().default(""),
    resultJson: jsonb("result_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    approvedBy: text("approved_by"),
    executedBy: text("executed_by"),
    idempotencyKey: text("idempotency_key").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "mcp_action_runs_install_workspace_team_fk",
      columns: [table.installId, table.workspaceId, table.teamId],
      foreignColumns: [
        workspaceMcpInstalls.id,
        workspaceMcpInstalls.workspaceId,
        workspaceMcpInstalls.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "mcp_action_runs_risk_check",
      sql`${table.risk} in ('read', 'write', 'destructive', 'unknown')`,
    ),
    check(
      "mcp_action_runs_status_check",
      sql`${table.status} in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    uniqueIndex("mcp_action_runs_idempotency_uq").on(
      table.workspaceId,
      table.installId,
      table.idempotencyKey,
    ),
    index("mcp_action_runs_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
  ],
);

export const connectorWebhookEvents = pgTable(
  "connector_webhook_events",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    connectorId: text("connector_id").references(() => sourceConnectors.id, {
      onDelete: "cascade",
    }),
    connectorType: text("connector_type").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").$type<ConnectorWebhookEventStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    objectId: text("object_id"),
    objectType: text("object_type"),
    syncRunId: text("sync_run_id").references(() => connectorSyncRuns.id, {
      onDelete: "set null",
    }),
    payloadMetadataJson: jsonb("payload_metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connector_webhook_events_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "connector_webhook_events_connector_workspace_team_fk",
      columns: [table.connectorId, table.workspaceId, table.teamId],
      foreignColumns: [
        sourceConnectors.id,
        sourceConnectors.workspaceId,
        sourceConnectors.teamId,
      ],
    }).onDelete("cascade"),
    check(
      "connector_webhook_events_status_check",
      sql`${table.status} in ('received', 'queued', 'processed', 'ignored', 'failed')`,
    ),
    check(
      "connector_webhook_events_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    uniqueIndex("connector_webhook_events_provider_event_uq").on(
      table.connectorType,
      table.providerEventId,
    ),
    index("connector_webhook_events_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    index("connector_webhook_events_connector_created_idx").on(
      table.connectorId,
      desc(table.createdAt),
    ),
    index("connector_webhook_events_status_received_idx").on(
      table.status,
      desc(table.receivedAt),
    ),
  ],
);

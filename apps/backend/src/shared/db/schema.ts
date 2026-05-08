import { desc, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

type WorkspaceRole = "workspace_admin" | "editor" | "viewer";
type WorkspaceMembershipSource = "direct" | "inherited";
type SourceStatus =
  | "created"
  | "queued"
  | "processing"
  | "indexed"
  | "failed"
  | "archived";
type SourceIngestKind =
  | "connector"
  | "manual_upload"
  | "web_url"
  | "youtube"
  | "note"
  | "artifact";
type SourceType =
  | "manual_upload"
  | "file_upload"
  | "web_url"
  | "youtube"
  | "note"
  | "artifact"
  | "connector"
  | "directory";
type ConnectorStatus = "active" | "paused" | "error" | "disabled";
type SyncRunTriggerType = "manual" | "scheduled" | "webhook" | "backfill";
type SyncRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type DocumentStatus = "pending" | "processing" | "ready" | "failed";
type ModelGatewayProfileKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";
type EmbeddingVectorStrategy = "auto" | "exact" | "disabled";
type ModelGatewayProviderKind =
  | "openai-compatible"
  | "openrouter"
  | "deepinfra"
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure-openai";
type ModelGatewayRouteKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";
type ThreadModelSettings = {
  llmProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
  llmModelAlias?: string | null;
  imageModelAlias?: string | null;
  visionModelAlias?: string | null;
};
type ModelGatewayRoutingStrategy =
  | "priority"
  | "weighted-random"
  | "least-latency"
  | "cost-aware"
  | "sticky-by-tenant";
type MessageRole = "user" | "assistant" | "system" | "tool";
type ThreadVisibility = "private" | "workspace" | "public_link";
type NoteType = "manual" | "saved_response" | "generated";
type ArtifactType =
  | "report"
  | "slides"
  | "mindmap"
  | "podcast"
  | "audio_overview"
  | "video_overview"
  | "flashcards"
  | "quiz"
  | "table"
  | "infographic";
type ArtifactStatus = "pending" | "running" | "ready" | "failed" | "archived";
type ArtifactSourceRole = "input" | "evidence" | "output";
type WorkingFilePurpose = "scratch" | "draft" | "note" | "output_candidate";
type ShareTargetType = "thread" | "artifact" | "chat_view";
type ShareAccessLevel = "viewer" | "editor";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type RetrievalStage = "bm25" | "vector" | "rrf" | "rerank";
type RetrievalHitType = "chunk" | "document";
type RetrievalVectorStrategy =
  | "ann_hnsw"
  | "exact_vector"
  | "bm25_only";
type LedgerEventType =
  | "grant"
  | "reserve"
  | "consume"
  | "release"
  | "refund"
  | "expire"
  | "adjust";
type LedgerUnitType = "credit" | "page";
type PlanFamily =
  | "individual_free"
  | "individual_pro"
  | "team_standard"
  | "team_premium"
  | "enterprise_usage";
type BillingProvider = "none" | "creem" | "stripe" | "manual";
type BillingSubscriptionStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "unpaid"
  | "canceled"
  | "expired";
type BillingWebhookStatus = "received" | "processed" | "ignored" | "failed";
type OpsAlertLevel = "warn" | "error" | "critical";
type OpsAlertStatus = "open" | "resolved";
type LlmObservationStatus = "running" | "ok" | "error" | "cancelled";
type LlmSpanKind =
  | "agent"
  | "tool"
  | "retrieval"
  | "vector_search"
  | "bm25"
  | "rerank"
  | "embedding"
  | "generation"
  | "system"
  | "thinking"
  | "http";
type RawCaptureMode =
  | "none"
  | "normalized"
  | "sdk_metadata"
  | "reconstructed"
  | "provider_wire";
type SkillDefinitionSourceType = "builtin" | "workspace_custom" | "team_custom";
type SkillDefinitionStatus = "active" | "archived";
type SkillVersionStatus = "draft" | "published" | "deprecated" | "disabled";
type SkillVersionStorageType = "repo_builtin" | "db_text";
export type SkillManifestVisibility = "public" | "restricted" | "workspace" | "team";
export type SkillManifestJson = {
  slug: string;
  displayName: string;
  version: string;
  description: string;
  visibility: SkillManifestVisibility;
  categories: string[];
};

const emptyJsonObject = sql`'{}'::jsonb`;

const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    if (!value) {
      return [];
    }

    const normalized = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!normalized) {
      return [];
    }

    return normalized
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((part) => Number.isFinite(part));
  },
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      ,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: text("created_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspaces_org_slug_uq").on(table.organizationId, table.slug),
    unique("workspaces_id_organization_uq").on(table.id, table.organizationId),
    index("workspaces_org_created_idx").on(
      table.organizationId,
      desc(table.createdAt),
    ),
    index("workspaces_org_updated_idx").on(
      table.organizationId,
      desc(table.updatedAt),
    ),
  ],
);

export const teamProfiles = pgTable(
  "team_profiles",
  {
    teamId: text("team_id")
      .primaryKey()
      ,
    displayName: text("display_name"),
    billingEmail: text("billing_email"),
    planFamily: text("plan_family").$type<PlanFamily>(),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "team_profiles_plan_family_check",
      sql`${table.planFamily} is null or ${table.planFamily} in ('individual_free', 'individual_pro', 'team_standard', 'team_premium', 'enterprise_usage')`,
    ),
  ],
);

export const teamAuditLogs = pgTable(
  "team_audit_logs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("team_audit_logs_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
    index("team_audit_logs_team_actor_created_idx").on(
      table.teamId,
      table.actorUserId,
      desc(table.createdAt),
    ),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      ,
    role: text("role")
      .$type<WorkspaceRole>()
      .notNull()
      .default("workspace_admin"),
    source: text("source")
      .$type<WorkspaceMembershipSource>()
      .notNull()
      .default("direct"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_memberships_user_idx").on(table.userId),
    index("workspace_memberships_workspace_role_idx").on(
      table.workspaceId,
      table.role,
    ),
    check(
      "workspace_memberships_role_check",
      sql`${table.role} in ('workspace_admin', 'editor', 'viewer')`,
    ),
    check(
      "workspace_memberships_source_check",
      sql`${table.source} in ('direct', 'inherited')`,
    ),
  ],
);

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    teamId: text("team_id")
      .primaryKey()
      ,
    planFamily: text("plan_family").$type<PlanFamily>().notNull(),
    cycleAnchorAt: timestamp("cycle_anchor_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    cycleSource: text("cycle_source")
      .$type<"free_account" | "provider_subscription" | "manual">()
      .notNull()
      .default("free_account"),
    cycleStartAt: timestamp("cycle_start_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    cycleEndAt: timestamp("cycle_end_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    pagesLimit: integer("pages_limit").notNull(),
    pagesUsed: integer("pages_used").notNull().default(0),
    monthlyPagesGrant: integer("monthly_pages_grant").notNull().default(0),
    monthlyPagesBalance: integer("monthly_pages_balance").notNull().default(0),
    addOnPagesBalance: integer("add_on_pages_balance").notNull().default(0),
    pagesConsumedThisCycle: integer("pages_consumed_this_cycle")
      .notNull()
      .default(0),
    monthlyCreditsGrant: integer("monthly_credits_grant").notNull(),
    monthlyCreditsBalance: integer("monthly_credits_balance").notNull(),
    addOnCreditsBalance: integer("add_on_credits_balance").notNull().default(0),
    creditsReserved: integer("credits_reserved").notNull().default(0),
    creditsConsumedThisCycle: integer("credits_consumed_this_cycle")
      .notNull()
      .default(0),
    seatCount: integer("seat_count").notNull().default(1),
    spendSoftCapUsd: numeric("spend_soft_cap_usd", {
      precision: 12,
      scale: 4,
    }),
    spendHardCapUsd: numeric("spend_hard_cap_usd", {
      precision: 12,
      scale: 4,
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_accounts_cycle_source_check",
      sql`${table.cycleSource} in ('free_account', 'provider_subscription', 'manual')`,
    ),
    check("billing_accounts_pages_limit_check", sql`${table.pagesLimit} >= 0`),
    check("billing_accounts_pages_used_check", sql`${table.pagesUsed} >= 0`),
    check(
      "billing_accounts_monthly_pages_grant_check",
      sql`${table.monthlyPagesGrant} >= 0`,
    ),
    check(
      "billing_accounts_monthly_pages_balance_check",
      sql`${table.monthlyPagesBalance} >= 0`,
    ),
    check(
      "billing_accounts_add_on_pages_balance_check",
      sql`${table.addOnPagesBalance} >= 0`,
    ),
    check(
      "billing_accounts_pages_consumed_check",
      sql`${table.pagesConsumedThisCycle} >= 0`,
    ),
    check(
      "billing_accounts_monthly_grant_check",
      sql`${table.monthlyCreditsGrant} >= 0`,
    ),
    check(
      "billing_accounts_monthly_balance_check",
      sql`${table.monthlyCreditsBalance} >= 0`,
    ),
    check(
      "billing_accounts_add_on_balance_check",
      sql`${table.addOnCreditsBalance} >= 0`,
    ),
    check(
      "billing_accounts_reserved_check",
      sql`${table.creditsReserved} >= 0`,
    ),
    check(
      "billing_accounts_consumed_check",
      sql`${table.creditsConsumedThisCycle} >= 0`,
    ),
    check(
      "billing_accounts_soft_cap_check",
      sql`${table.spendSoftCapUsd} is null or ${table.spendSoftCapUsd} >= 0`,
    ),
    check(
      "billing_accounts_hard_cap_check",
      sql`${table.spendHardCapUsd} is null or ${table.spendHardCapUsd} >= 0`,
    ),
    check(
      "billing_accounts_hard_gte_soft_check",
      sql`${table.spendSoftCapUsd} is null or ${table.spendHardCapUsd} is null or ${table.spendHardCapUsd} >= ${table.spendSoftCapUsd}`,
    ),
    check("billing_accounts_seat_count_check", sql`${table.seatCount} >= 1`),
  ],
);

export const usageLedgers = pgTable(
  "usage_ledgers",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    actorUserId: text("actor_user_id"),
    feature: text("feature").notNull(),
    eventType: text("event_type").$type<LedgerEventType>().notNull(),
    unitType: text("unit_type").$type<LedgerUnitType>().notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    referenceId: text("reference_id"),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "usage_ledgers_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }),
    check(
      "usage_ledgers_event_type_check",
      sql`${table.eventType} in ('grant', 'reserve', 'consume', 'release', 'refund', 'expire', 'adjust')`,
    ),
    check(
      "usage_ledgers_unit_type_check",
      sql`${table.unitType} in ('credit', 'page')`,
    ),
    index("usage_ledgers_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
    index("usage_ledgers_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
    uniqueIndex("usage_ledgers_team_idempotency_uq").on(
      table.teamId,
      table.idempotencyKey,
    ),
  ],
);

export const spendLimits = pgTable(
  "spend_limits",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    scope: text("scope").notNull().default("team"),
    actorUserId: text("actor_user_id"),
    softCapUsd: numeric("soft_cap_usd", { precision: 12, scale: 4 }),
    hardCapUsd: numeric("hard_cap_usd", { precision: 12, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "spend_limits_soft_cap_check",
      sql`${table.softCapUsd} is null or ${table.softCapUsd} >= 0`,
    ),
    check(
      "spend_limits_hard_cap_check",
      sql`${table.hardCapUsd} is null or ${table.hardCapUsd} >= 0`,
    ),
    check(
      "spend_limits_hard_gte_soft_check",
      sql`${table.softCapUsd} is null or ${table.hardCapUsd} is null or ${table.hardCapUsd} >= ${table.softCapUsd}`,
    ),
    uniqueIndex("spend_limits_team_scope_user_uq").on(
      table.teamId,
      table.scope,
      sql`coalesce(${table.actorUserId}, '')`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    provider: text("provider")
      .$type<BillingProvider>()
      .notNull()
      .default("none"),
    planFamily: text("plan_family").$type<PlanFamily>().notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
    billingInterval: text("billing_interval")
      .$type<"monthly" | "yearly" | "unknown">()
      .notNull()
      .default("unknown"),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "date",
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "date",
    }),
    externalCustomerId: text("external_customer_id"),
    externalSubscriptionId: text("external_subscription_id"),
    externalProductId: text("external_product_id"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastEventAt: timestamp("last_event_at", {
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
    unique("subscriptions_team_id_uq").on(table.teamId),
    uniqueIndex("subscriptions_provider_external_subscription_uq").on(
      table.provider,
      table.externalSubscriptionId,
    ),
    check(
      "subscriptions_provider_check",
      sql`${table.provider} in ('none', 'creem', 'stripe', 'manual')`,
    ),
    check(
      "subscriptions_status_check",
      sql`${table.status} in ('inactive', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled', 'expired')`,
    ),
    check(
      "subscriptions_billing_interval_check",
      sql`${table.billingInterval} in ('monthly', 'yearly', 'unknown')`,
    ),
  ],
);

export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").$type<BillingProvider>().notNull(),
    providerEventId: text("provider_event_id"),
    eventType: text("event_type").notNull(),
    teamId: text("team_id"),
    externalSubscriptionId: text("external_subscription_id"),
    status: text("status").$type<BillingWebhookStatus>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_webhook_events_provider_event_uq").on(
      table.provider,
      table.providerEventId,
    ),
    check(
      "billing_webhook_events_status_check",
      sql`${table.status} in ('received', 'processed', 'ignored', 'failed')`,
    ),
    check(
      "billing_webhook_events_provider_check",
      sql`${table.provider} in ('none', 'creem', 'stripe', 'manual')`,
    ),
    index("billing_webhook_events_team_status_idx").on(
      table.teamId,
      table.status,
      desc(table.receivedAt),
    ),
    index("billing_webhook_events_status_received_idx").on(
      table.status,
      desc(table.receivedAt),
    ),
  ],
);

export const opsAlerts = pgTable(
  "ops_alerts",
  {
    id: text("id").primaryKey(),
    alertKey: text("alert_key").notNull(),
    level: text("level").$type<OpsAlertLevel>().notNull(),
    status: text("status").$type<OpsAlertStatus>().notNull().default("open"),
    source: text("source").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    teamId: text("team_id"),
    triggerCount: integer("trigger_count").notNull().default(1),
    firstTriggeredAt: timestamp("first_triggered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastTriggeredAt: timestamp("last_triggered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastNotifiedAt: timestamp("last_notified_at", {
      withTimezone: true,
      mode: "date",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ops_alerts_alert_key_uq").on(table.alertKey),
    check(
      "ops_alerts_level_check",
      sql`${table.level} in ('warn', 'error', 'critical')`,
    ),
    check(
      "ops_alerts_status_check",
      sql`${table.status} in ('open', 'resolved')`,
    ),
    index("ops_alerts_level_status_triggered_idx").on(
      table.level,
      table.status,
      desc(table.lastTriggeredAt),
    ),
    index("ops_alerts_source_triggered_idx").on(
      table.source,
      desc(table.lastTriggeredAt),
    ),
  ],
);

export const modelGatewayConfigs = pgTable(
  "model_gateway_configs",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    maxRetries: integer("max_retries").notNull().default(2),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    isBYOK: boolean("is_byok").notNull().default(false),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_configs_slug_uq").on(table.slug),
    uniqueIndex("model_gateway_configs_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    check(
      "model_gateway_configs_timeout_ms_check",
      sql`${table.timeoutMs} > 0`,
    ),
    check(
      "model_gateway_configs_max_retries_check",
      sql`${table.maxRetries} >= 0`,
    ),
    index("model_gateway_configs_default_active_idx").on(
      table.isDefault,
      table.isActive,
    ),
  ],
);

export const modelGatewayConfigVersions = pgTable(
  "model_gateway_config_versions",
  {
    id: text("id").primaryKey(),
    versionHash: text("version_hash").notNull(),
    sourcePath: text("source_path"),
    isActive: boolean("is_active").notNull().default(false),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_config_versions_hash_uq").on(table.versionHash),
    uniqueIndex("model_gateway_config_versions_active_uq")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
    index("model_gateway_config_versions_created_idx").on(desc(table.createdAt)),
  ],
);

export const modelGatewayProviderConfigs = pgTable(
  "model_gateway_provider_configs",
  {
    id: text("id").primaryKey(),
    configVersionId: text("config_version_id")
      .notNull()
      .references(() => modelGatewayConfigVersions.id, { onDelete: "cascade" }),
    providerName: text("provider_name").notNull(),
    providerKind: text("provider_kind")
      .$type<ModelGatewayProviderKind>()
      .notNull(),
    gatewayConfigId: text("gateway_config_id").references(
      () => modelGatewayConfigs.id,
      { onDelete: "set null" },
    ),
    baseUrl: text("base_url").notNull(),
    apiKeySource: text("api_key_source"),
    isActive: boolean("is_active").notNull().default(true),
    capabilitiesJson: jsonb("capabilities_json")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_provider_configs_version_name_uq").on(
      table.configVersionId,
      table.providerName,
    ),
    check(
      "model_gateway_provider_configs_kind_check",
      sql`${table.providerKind} in ('openai-compatible', 'openrouter', 'deepinfra', 'openai', 'anthropic', 'gemini', 'azure-openai')`,
    ),
    index("model_gateway_provider_configs_active_idx").on(
      table.configVersionId,
      table.isActive,
    ),
  ],
);

export const modelGatewayByokKeyRefs = pgTable(
  "model_gateway_byok_key_refs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    providerName: text("provider_name").notNull(),
    keyRef: text("key_ref").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "model_gateway_byok_key_refs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("model_gateway_byok_key_refs_lookup_idx").on(
      table.teamId,
      table.workspaceId,
      table.userId,
      table.providerName,
      table.keyRef,
      table.isActive,
    ),
    uniqueIndex("model_gateway_byok_key_refs_scope_uq").on(
      table.workspaceId,
      table.userId,
      table.providerName,
      table.keyRef,
    ),
  ],
);

export const modelGatewayRoutes = pgTable(
  "model_gateway_routes",
  {
    id: text("id").primaryKey(),
    configVersionId: text("config_version_id")
      .notNull()
      .references(() => modelGatewayConfigVersions.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    routeKind: text("route_kind").$type<ModelGatewayRouteKind>().notNull(),
    strategy: text("strategy")
      .$type<ModelGatewayRoutingStrategy>()
      .notNull()
      .default("priority"),
    targetProviderName: text("target_provider_name").notNull(),
    targetModel: text("target_model").notNull(),
    priority: integer("priority").notNull().default(1),
    weight: integer("weight").notNull().default(0),
    constraintsJson: jsonb("constraints_json")
      .$type<Record<string, never>>()
      .notNull()
      .default(emptyJsonObject),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "model_gateway_routes_kind_check",
      sql`${table.routeKind} in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')`,
    ),
    check(
      "model_gateway_routes_strategy_check",
      sql`${table.strategy} in ('priority', 'weighted-random', 'least-latency', 'cost-aware', 'sticky-by-tenant')`,
    ),
    check(
      "model_gateway_routes_priority_check",
      sql`${table.priority} > 0`,
    ),
    check(
      "model_gateway_routes_weight_check",
      sql`${table.weight} >= 0`,
    ),
    index("model_gateway_routes_lookup_idx").on(
      table.configVersionId,
      table.alias,
      table.routeKind,
      table.isActive,
    ),
  ],
);

export const modelGatewayProfiles = pgTable(
  "model_gateway_profiles",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ModelGatewayProfileKind>().notNull(),
    gatewayConfigId: text("gateway_config_id")
      .notNull()
      .references(() => modelGatewayConfigs.id, { onDelete: "cascade" }),
    profileAlias: text("profile_alias").notNull(),
    modelAlias: text("model_alias").notNull(),
    requestedDimensions: integer("requested_dimensions"),
    vectorStrategy: text("vector_strategy")
      .$type<EmbeddingVectorStrategy>()
      .notNull()
      .default("auto"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_profiles_alias_uq").on(table.profileAlias),
    uniqueIndex("model_gateway_profiles_default_kind_uq")
      .on(table.kind)
      .where(sql`${table.isDefault} = true`),
    check(
      "model_gateway_profiles_kind_check",
      sql`${table.kind} in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')`,
    ),
    check(
      "model_gateway_profiles_vector_strategy_check",
      sql`${table.vectorStrategy} in ('auto', 'exact', 'disabled')`,
    ),
    check(
      "model_gateway_profiles_requested_dimensions_check",
      sql`${table.requestedDimensions} is null or (${table.requestedDimensions} > 0 and ${table.requestedDimensions} <= 2000)`,
    ),
    index("model_gateway_profiles_kind_default_active_idx").on(
      table.kind,
      table.isDefault,
      table.isActive,
    ),
  ],
);

export const sourceConnectors = pgTable(
  "source_connectors",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
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

export const connectorSyncRuns = pgTable(
  "connector_sync_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
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
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
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

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ingestKind: text("ingest_kind")
      .$type<SourceIngestKind>()
      .notNull()
      .default("manual_upload"),
    sourceType: text("source_type").$type<SourceType>().notNull().default("manual_upload"),
    connectorId: text("connector_id").references(() => sourceConnectors.id),
    syncRunId: text("sync_run_id").references(() => connectorSyncRuns.id),
    parentSourceId: text("parent_source_id"),
    title: text("title").notNull(),
    contentText: text("content_text").notNull().default(""),
    externalId: text("external_id"),
    externalUri: text("external_uri"),
    externalUpdatedAt: timestamp("external_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    contentHash: text("content_hash"),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    parserVersion: text("parser_version"),
    parsingConfig: jsonb("parsing_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    status: text("status").$type<SourceStatus>().notNull().default("created"),
    estimatedPages: integer("estimated_pages"),
    parsedTokens: integer("parsed_tokens"),
    errorJson: jsonb("error_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdBy: text("created_by"),
    indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "sources_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    unique("sources_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "sources_status_check",
      sql`${table.status} in ('created', 'queued', 'processing', 'indexed', 'failed', 'archived')`,
    ),
    check(
      "sources_ingest_kind_check",
      sql`${table.ingestKind} in ('connector', 'manual_upload', 'web_url', 'youtube', 'note', 'artifact')`,
    ),
    check(
      "sources_source_type_check",
      sql`${table.sourceType} in ('manual_upload', 'file_upload', 'web_url', 'youtube', 'note', 'artifact', 'connector', 'directory')`,
    ),
    check(
      "sources_connector_requirement_check",
      sql`(${table.ingestKind} = 'connector' and ${table.connectorId} is not null) or (${table.ingestKind} <> 'connector' and ${table.connectorId} is null)`,
    ),
    check(
      "sources_estimated_pages_check",
      sql`${table.estimatedPages} is null or ${table.estimatedPages} > 0`,
    ),
    check(
      "sources_parsed_tokens_check",
      sql`${table.parsedTokens} is null or ${table.parsedTokens} > 0`,
    ),
    check(
      "sources_size_bytes_check",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    uniqueIndex("sources_connector_external_id_uq")
      .on(table.connectorId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    uniqueIndex("sources_workspace_content_hash_uq")
      .on(table.workspaceId, table.contentHash)
      .where(sql`${table.contentHash} is not null`),
    index("sources_team_workspace_status_updated_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
      desc(table.updatedAt),
    ),
    index("sources_team_workspace_parent_idx").on(
      table.teamId,
      table.workspaceId,
      table.parentSourceId,
    ),
    index("sources_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);

export const sourceRevisions = pgTable(
  "source_revisions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    revisionNo: integer("revision_no").notNull(),
    contentHash: text("content_hash"),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    externalUpdatedAt: timestamp("external_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    parserVersion: text("parser_version"),
    isLatest: boolean("is_latest").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "source_revisions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "source_revisions_source_workspace_team_fk",
      columns: [table.sourceId, table.workspaceId, table.teamId],
      foreignColumns: [sources.id, sources.workspaceId, sources.teamId],
    }).onDelete("cascade"),
    uniqueIndex("source_revisions_source_revision_uq").on(
      table.sourceId,
      table.revisionNo,
    ),
    uniqueIndex("source_revisions_source_latest_uq")
      .on(table.sourceId)
      .where(sql`${table.isLatest} = true`),
    index("source_revisions_source_latest_idx").on(
      table.sourceId,
      table.isLatest,
      desc(table.createdAt),
    ),
    check("source_revisions_revision_no_check", sql`${table.revisionNo} > 0`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id").references(
      () => sourceRevisions.id,
    ),
    title: text("title"),
    language: text("language"),
    contentText: text("content_text").notNull(),
    tokenCount: integer("token_count"),
    charCount: integer("char_count"),
    status: text("status").$type<DocumentStatus>().notNull().default("pending"),
    documentMetadata: jsonb("document_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "documents_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "documents_source_workspace_team_fk",
      columns: [table.sourceId, table.workspaceId, table.teamId],
      foreignColumns: [sources.id, sources.workspaceId, sources.teamId],
    }).onDelete("cascade"),
    unique("documents_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "documents_status_check",
      sql`${table.status} in ('pending', 'processing', 'ready', 'failed')`,
    ),
    check(
      "documents_token_count_check",
      sql`${table.tokenCount} is null or ${table.tokenCount} >= 0`,
    ),
    check(
      "documents_char_count_check",
      sql`${table.charCount} is null or ${table.charCount} >= 0`,
    ),
    index("documents_source_idx").on(table.sourceId),
    index("documents_workspace_updated_idx").on(
      table.workspaceId,
      desc(table.updatedAt),
    ),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkNo: integer("chunk_no").notNull(),
    content: text("content").notNull(),
    headingPath: text("heading_path"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    language: text("language"),
    chunkMetadata: jsonb("chunk_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chunks_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "chunks_document_workspace_team_fk",
      columns: [table.documentId, table.workspaceId, table.teamId],
      foreignColumns: [documents.id, documents.workspaceId, documents.teamId],
    }).onDelete("cascade"),
    uniqueIndex("chunks_document_chunk_no_uq").on(
      table.documentId,
      table.chunkNo,
    ),
    check("chunks_chunk_no_check", sql`${table.chunkNo} >= 0`),
    check(
      "chunks_offsets_check",
      sql`${table.startOffset} is null or ${table.endOffset} is null or ${table.startOffset} <= ${table.endOffset}`,
    ),
    index("chunks_workspace_document_chunk_idx").on(
      table.workspaceId,
      table.documentId,
      table.chunkNo,
    ),
    index("chunks_source_chunk_idx").on(table.sourceId, table.chunkNo),
  ],
);

export const chunkEmbeddings = pgTable(
  "chunk_embeddings",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    embeddingProfileId: text("embedding_profile_id")
      .notNull()
      .references(() => modelGatewayProfiles.id, { onDelete: "cascade" }),
    modelAlias: text("model_alias").notNull(),
    dim: integer("dim").notNull(),
    embedding: pgVector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chunk_embeddings_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("chunk_embeddings_chunk_profile_uq").on(
      table.chunkId,
      table.embeddingProfileId,
    ),
    check("chunk_embeddings_dim_check", sql`${table.dim} > 0 and ${table.dim} <= 2000`),
    index("chunk_embeddings_workspace_profile_created_idx").on(
      table.workspaceId,
      table.embeddingProfileId,
      desc(table.createdAt),
    ),
    index("chunk_embeddings_chunk_created_idx").on(
      table.chunkId,
      desc(table.createdAt),
    ),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    modelSettingsJson: jsonb("model_settings_json")
      .$type<ThreadModelSettings>()
      .notNull()
      .default(emptyJsonObject),
    visibility: text("visibility")
      .$type<ThreadVisibility>()
      .notNull()
      .default("private"),
    archived: boolean("archived").notNull().default(false),
    createdBy: text("created_by"),
    lastMessageAt: timestamp("last_message_at", {
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
      name: "threads_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    unique("threads_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "threads_visibility_check",
      sql`${table.visibility} in ('private', 'workspace', 'public_link')`,
    ),
    index("threads_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
    index("threads_workspace_last_message_idx").on(
      table.workspaceId,
      desc(table.lastMessageAt),
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentMessageId: text("parent_message_id").references(
      (): AnyPgColumn => messages.id,
      {
        onDelete: "set null",
      },
    ),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    contentJson: jsonb("content_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdBy: text("created_by"),
    model: text("model"),
    modelAlias: text("model_alias"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    providerCostUsd: numeric("provider_cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms"),
    creditsConsumed: integer("credits_consumed"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "messages_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "messages_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    check(
      "messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'system', 'tool')`,
    ),
    check(
      "messages_input_tokens_check",
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`,
    ),
    check(
      "messages_output_tokens_check",
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`,
    ),
    check(
      "messages_total_tokens_check",
      sql`${table.totalTokens} is null or ${table.totalTokens} >= 0`,
    ),
    check(
      "messages_provider_cost_check",
      sql`${table.providerCostUsd} is null or ${table.providerCostUsd} >= 0`,
    ),
    check(
      "messages_latency_ms_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      "messages_credits_consumed_check",
      sql`${table.creditsConsumed} is null or ${table.creditsConsumed} >= 0`,
    ),
    index("messages_thread_created_idx").on(table.threadId, table.createdAt),
    index("messages_thread_role_created_idx").on(
      table.threadId,
      table.role,
      table.createdAt,
    ),
    index("messages_parent_message_idx").on(table.parentMessageId),
    index("messages_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);

export const workingFiles = pgTable(
  "working_files",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentText: text("content_text").notNull().default(""),
    mimeType: text("mime_type").notNull().default("text/plain"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    purpose: text("purpose").$type<WorkingFilePurpose>(),
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
      name: "working_files_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "working_files_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    uniqueIndex("working_files_thread_path_uq").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      table.path,
    ),
    check(
      "working_files_path_check",
      sql`${table.path} ~ '^/work/[^[:cntrl:]]+$' and ${table.path} not like '%..%' and ${table.path} not like '%~%' and ${table.path} not like '%//%'`,
    ),
    check(
      "working_files_purpose_check",
      sql`${table.purpose} is null or ${table.purpose} in ('scratch', 'draft', 'note', 'output_candidate')`,
    ),
    check(
      "working_files_size_bytes_check",
      sql`${table.sizeBytes} >= 0`,
    ),
    index("working_files_thread_updated_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      desc(table.updatedAt),
    ),
  ],
);

export const citations = pgTable(
  "citations",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    chunkId: text("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    citationKey: text("citation_key").notNull(),
    quoteText: text("quote_text"),
    startChar: integer("start_char"),
    endChar: integer("end_char"),
    rank: integer("rank"),
    score: doublePrecision("score"),
    externalUri: text("external_uri"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "citations_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("citations_message_key_uq").on(
      table.messageId,
      table.citationKey,
    ),
    check(
      "citations_rank_check",
      sql`${table.rank} is null or ${table.rank} > 0`,
    ),
    check(
      "citations_position_check",
      sql`${table.startChar} is null or ${table.endChar} is null or ${table.startChar} <= ${table.endChar}`,
    ),
    check(
      "citations_target_check",
      sql`${table.chunkId} is not null or ${table.externalUri} is not null`,
    ),
    index("citations_message_rank_idx").on(table.messageId, table.rank),
    index("citations_chunk_idx").on(table.chunkId),
    index("citations_source_document_idx").on(table.sourceId, table.documentId),
  ],
);

export const skillDefinitions = pgTable(
  "skill_definitions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    sourceType: text("source_type")
      .$type<SkillDefinitionSourceType>()
      .notNull(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    visibility: text("visibility")
      .$type<SkillManifestVisibility>()
      .notNull(),
    status: text("status")
      .$type<SkillDefinitionStatus>()
      .notNull()
      .default("active"),
    ownerUserId: text("owner_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "skill_definitions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "skill_definitions_source_type_check",
      sql`${table.sourceType} in ('builtin', 'workspace_custom', 'team_custom')`,
    ),
    check(
      "skill_definitions_visibility_check",
      sql`${table.visibility} in ('public', 'restricted', 'workspace', 'team')`,
    ),
    check(
      "skill_definitions_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "skill_definitions_scope_check",
      sql`(${table.sourceType} = 'builtin' and ${table.teamId} is null and ${table.workspaceId} is null and ${table.visibility} in ('public', 'restricted')) or (${table.sourceType} = 'workspace_custom' and ${table.teamId} is not null and ${table.workspaceId} is not null and ${table.visibility} = 'workspace') or (${table.sourceType} = 'team_custom' and ${table.teamId} is not null and ${table.workspaceId} is null and ${table.visibility} = 'team')`,
    ),
    uniqueIndex("skill_definitions_slug_uq").on(table.slug),
    index("skill_definitions_team_workspace_status_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
    ),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status")
      .$type<SkillVersionStatus>()
      .notNull()
      .default("draft"),
    storageType: text("storage_type")
      .$type<SkillVersionStorageType>()
      .notNull(),
    storagePointer: text("storage_pointer").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    contentHash: text("content_hash").notNull(),
    manifestJson: jsonb("manifest_json")
      .$type<SkillManifestJson>()
      .notNull(),
    createdBy: text("created_by"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "skill_versions_status_check",
      sql`${table.status} in ('draft', 'published', 'deprecated', 'disabled')`,
    ),
    check(
      "skill_versions_storage_type_check",
      sql`${table.storageType} in ('repo_builtin', 'db_text')`,
    ),
    uniqueIndex("skill_versions_skill_version_uq").on(
      table.skillId,
      table.version,
    ),
    uniqueIndex("skill_versions_skill_current_uq")
      .on(table.skillId)
      .where(sql`${table.isCurrent} = true`),
    index("skill_versions_skill_status_idx").on(table.skillId, table.status),
  ],
);

export const skillVersionFiles = pgTable(
  "skill_version_files",
  {
    id: text("id").primaryKey(),
    skillVersionId: text("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentText: text("content_text").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_version_files_version_path_uq").on(
      table.skillVersionId,
      table.path,
    ),
    check("skill_version_files_size_check", sql`${table.sizeBytes} >= 0`),
    check(
      "skill_version_files_relative_path_check",
      sql`${table.path} <> '' and ${table.path} not like '/%' and ${table.path} not like '../%' and ${table.path} not like '%/../%'`,
    ),
  ],
);

export const workspaceSkills = pgTable(
  "workspace_skills",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    skillVersionId: text("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    enabledBy: text("enabled_by"),
    enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_skills_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("workspace_skills_skill_uq").on(table.workspaceId, table.skillId),
    index("workspace_skills_workspace_enabled_idx").on(
      table.teamId,
      table.workspaceId,
      table.enabled,
    ),
  ],
);

export const skillEntitlements = pgTable(
  "skill_entitlements",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    teamId: text("team_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    grantedBy: text("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "skill_entitlements_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "skill_entitlements_scope_check",
      sql`${table.teamId} is not null or ${table.workspaceId} is not null`,
    ),
    index("skill_entitlements_skill_idx").on(
      table.skillId,
      table.teamId,
      table.workspaceId,
    ),
  ],
);

export const modelGatewayEvents = pgTable(
  "model_gateway_events",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    feature: text("feature"),
    operation: text("operation").notNull(),
    executionMode: text("execution_mode"),
    keySource: text("key_source"),
    provider: text("provider"),
    providerModel: text("provider_model"),
    modelAlias: text("model_alias"),
    routeStrategy: text("route_strategy"),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    providerCostUsd: numeric("provider_cost_usd", {
      precision: 12,
      scale: 6,
    }),
    attributesJson: jsonb("attributes_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "model_gateway_events_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("model_gateway_events_trace_idx").on(table.traceId, table.createdAt),
    index("model_gateway_events_provider_idx").on(
      table.provider,
      table.operation,
      table.createdAt,
    ),
    index("model_gateway_events_team_workspace_idx").on(
      table.teamId,
      table.workspaceId,
      table.createdAt,
    ),
    index("model_gateway_events_team_provider_idx").on(
      table.teamId,
      table.provider,
      table.createdAt,
    ),
  ],
);

export const llmTraces = pgTable(
  "llm_traces",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id"),
    name: text("name").notNull(),
    feature: text("feature"),
    inputJson: jsonb("input_json").$type<Record<string, unknown> | null>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown> | null>(),
    status: text("status")
      .$type<LlmObservationStatus>()
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    latencyMs: integer("latency_ms"),
    tagsJson: jsonb("tags_json")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "llm_traces_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "llm_traces_status_check",
      sql`${table.status} in ('running', 'ok', 'error', 'cancelled')`,
    ),
    check(
      "llm_traces_latency_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    uniqueIndex("llm_traces_scope_trace_uq").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
    ),
    index("llm_traces_trace_idx").on(table.traceId),
    index("llm_traces_team_workspace_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.startedAt,
    ),
    index("llm_traces_team_workspace_started_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.startedAt,
      table.id,
    ),
    index("llm_traces_team_started_idx").on(table.teamId, table.startedAt),
    index("llm_traces_team_started_id_idx").on(table.teamId, table.startedAt, table.id),
    index("llm_traces_thread_started_idx").on(
      table.threadId,
      table.startedAt,
    ),
    index("llm_traces_message_idx").on(table.messageId),
    index("llm_traces_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
  ],
);

export const llmSpans = pgTable(
  "llm_spans",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    kind: text("kind").$type<LlmSpanKind>().notNull(),
    operation: text("operation").notNull(),
    status: text("status")
      .$type<LlmObservationStatus>()
      .notNull()
      .default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    latencyMs: integer("latency_ms"),
    inputJson: jsonb("input_json").$type<Record<string, unknown> | null>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown> | null>(),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "llm_spans_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "llm_spans_kind_check",
      sql`${table.kind} in ('agent', 'tool', 'retrieval', 'vector_search', 'bm25', 'rerank', 'embedding', 'generation', 'system', 'thinking', 'http')`,
    ),
    check(
      "llm_spans_status_check",
      sql`${table.status} in ('running', 'ok', 'error', 'cancelled')`,
    ),
    check(
      "llm_spans_latency_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    uniqueIndex("llm_spans_scope_trace_span_uq").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.spanId,
    ),
    index("llm_spans_trace_idx").on(table.traceId, table.startedAt),
    index("llm_spans_scope_trace_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.startedAt,
    ),
    index("llm_spans_parent_idx").on(
      table.traceId,
      table.parentSpanId,
      table.startedAt,
    ),
    index("llm_spans_scope_parent_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.parentSpanId,
      table.startedAt,
    ),
    index("llm_spans_team_workspace_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.startedAt,
    ),
    index("llm_spans_kind_started_idx").on(table.kind, table.startedAt),
  ],
);

export const llmGenerations = pgTable(
  "llm_generations",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    operation: text("operation").notNull(),
    modelAlias: text("model_alias"),
    provider: text("provider"),
    providerModel: text("provider_model"),
    executionMode: text("execution_mode"),
    keySource: text("key_source"),
    routeStrategy: text("route_strategy"),
    routeDecisionJson: jsonb("route_decision_json").$type<Record<string, unknown> | null>(),
    modelParametersJson: jsonb("model_parameters_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    inputJson: jsonb("input_json").$type<Record<string, unknown> | null>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown> | null>(),
    outputText: text("output_text"),
    finishReason: text("finish_reason"),
    reasoningText: text("reasoning_text"),
    providerFieldsJson: jsonb("provider_fields_json").$type<Record<string, unknown> | null>(),
    usageJson: jsonb("usage_json").$type<Record<string, unknown> | null>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    providerCostUsd: numeric("provider_cost_usd", {
      precision: 12,
      scale: 6,
    }),
    rawCaptureMode: text("raw_capture_mode")
      .$type<RawCaptureMode>()
      .notNull()
      .default("normalized"),
    providerRequestJson: jsonb("provider_request_json").$type<Record<string, unknown> | null>(),
    providerResponseJson: jsonb("provider_response_json").$type<Record<string, unknown> | null>(),
    providerRequestHeadersJson: jsonb("provider_request_headers_json").$type<Record<string, unknown> | null>(),
    providerResponseHeadersJson: jsonb("provider_response_headers_json").$type<Record<string, unknown> | null>(),
    providerStatusCode: integer("provider_status_code"),
    providerRequestId: text("provider_request_id"),
    rawCaptureError: text("raw_capture_error"),
    status: text("status")
      .$type<LlmObservationStatus>()
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    latencyMs: integer("latency_ms"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "llm_generations_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "llm_generations_status_check",
      sql`${table.status} in ('running', 'ok', 'error', 'cancelled')`,
    ),
    check(
      "llm_generations_raw_capture_mode_check",
      sql`${table.rawCaptureMode} in ('none', 'normalized', 'sdk_metadata', 'reconstructed', 'provider_wire')`,
    ),
    check(
      "llm_generations_execution_mode_check",
      sql`${table.executionMode} is null or ${table.executionMode} in ('GLOBAL', 'BYOK')`,
    ),
    check(
      "llm_generations_latency_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      "llm_generations_input_tokens_check",
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`,
    ),
    check(
      "llm_generations_output_tokens_check",
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`,
    ),
    check(
      "llm_generations_total_tokens_check",
      sql`${table.totalTokens} is null or ${table.totalTokens} >= 0`,
    ),
    check(
      "llm_generations_provider_status_check",
      sql`${table.providerStatusCode} is null or ${table.providerStatusCode} between 100 and 599`,
    ),
    uniqueIndex("llm_generations_scope_trace_span_uq").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.spanId,
    ),
    index("llm_generations_trace_idx").on(table.traceId, table.startedAt),
    index("llm_generations_scope_trace_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.startedAt,
    ),
    index("llm_generations_parent_idx").on(
      table.traceId,
      table.parentSpanId,
      table.startedAt,
    ),
    index("llm_generations_scope_parent_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.parentSpanId,
      table.startedAt,
    ),
    index("llm_generations_team_workspace_started_idx").on(
      table.teamId,
      table.workspaceId,
      table.startedAt,
    ),
    index("llm_generations_team_workspace_started_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.startedAt,
      table.id,
    ),
    index("llm_generations_operation_started_idx").on(
      table.operation,
      table.startedAt,
    ),
    index("llm_generations_provider_started_idx").on(
      table.provider,
      table.providerModel,
      table.startedAt,
    ),
    index("llm_generations_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
    index("llm_generations_message_idx").on(table.messageId),
  ],
);

export const llmFeedbackScores = pgTable(
  "llm_feedback_scores",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id"),
    generationId: text("generation_id"),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    value: doublePrecision("value").notNull(),
    comment: text("comment"),
    source: text("source"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "llm_feedback_scores_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("llm_feedback_scores_trace_idx").on(
      table.traceId,
      table.createdAt,
    ),
    index("llm_feedback_scores_generation_idx").on(
      table.generationId,
      table.createdAt,
    ),
    index("llm_feedback_scores_team_workspace_idx").on(
      table.teamId,
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

export const llmAuditAccessLogs = pgTable(
  "llm_audit_access_logs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    action: text("action").notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "llm_audit_access_logs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("llm_audit_access_logs_team_workspace_idx").on(
      table.teamId,
      table.workspaceId,
      table.createdAt,
    ),
    index("llm_audit_access_logs_actor_idx").on(
      table.teamId,
      table.actorUserId,
      table.createdAt,
    ),
    index("llm_audit_access_logs_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

export const retrievalRuns = pgTable(
  "retrieval_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    embeddingProfileId: text("embedding_profile_id").references(
      () => modelGatewayProfiles.id,
      {
        onDelete: "set null",
      },
    ),
    queryText: text("query_text").notNull(),
    embedModelAlias: text("embed_model_alias"),
    rerankModelAlias: text("rerank_model_alias"),
    vectorStrategyUsed: text(
      "vector_strategy_used",
    ).$type<RetrievalVectorStrategy>(),
    annIndexUsed: text("ann_index_used"),
    bm25TopK: integer("bm25_top_k"),
    vectorTopK: integer("vector_top_k"),
    rrfK: integer("rrf_k"),
    prefilterCount: integer("prefilter_count"),
    candidateCount: integer("candidate_count"),
    finalResultCount: integer("final_result_count"),
    latencyMs: integer("latency_ms"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "retrieval_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "retrieval_runs_vector_strategy_used_check",
      sql`${table.vectorStrategyUsed} is null or ${table.vectorStrategyUsed} in ('ann_hnsw', 'exact_vector', 'bm25_only')`,
    ),
    check(
      "retrieval_runs_bm25_top_k_check",
      sql`${table.bm25TopK} is null or ${table.bm25TopK} > 0`,
    ),
    check(
      "retrieval_runs_vector_top_k_check",
      sql`${table.vectorTopK} is null or ${table.vectorTopK} > 0`,
    ),
    check(
      "retrieval_runs_rrf_k_check",
      sql`${table.rrfK} is null or ${table.rrfK} > 0`,
    ),
    check(
      "retrieval_runs_prefilter_count_check",
      sql`${table.prefilterCount} is null or ${table.prefilterCount} >= 0`,
    ),
    check(
      "retrieval_runs_candidate_count_check",
      sql`${table.candidateCount} is null or ${table.candidateCount} >= 0`,
    ),
    check(
      "retrieval_runs_final_result_count_check",
      sql`${table.finalResultCount} is null or ${table.finalResultCount} >= 0`,
    ),
    check(
      "retrieval_runs_latency_ms_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    index("retrieval_runs_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_thread_created_idx").on(
      table.threadId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_message_created_idx").on(
      table.messageId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_profile_created_idx").on(
      table.embeddingProfileId,
      desc(table.createdAt),
    ),
  ],
);

export const retrievalHits = pgTable(
  "retrieval_hits",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => retrievalRuns.id, { onDelete: "cascade" }),
    sourceStage: text("source_stage").$type<RetrievalStage>().notNull(),
    hitType: text("hit_type").$type<RetrievalHitType>().notNull(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    chunkId: text("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    rank: integer("rank").notNull(),
    score: doublePrecision("score"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "retrieval_hits_source_stage_check",
      sql`${table.sourceStage} in ('bm25', 'vector', 'rrf', 'rerank')`,
    ),
    check(
      "retrieval_hits_hit_type_check",
      sql`${table.hitType} in ('chunk', 'document')`,
    ),
    check("retrieval_hits_rank_check", sql`${table.rank} > 0`),
    index("retrieval_hits_run_stage_rank_idx").on(
      table.runId,
      table.sourceStage,
      table.rank,
    ),
    index("retrieval_hits_run_created_idx").on(
      table.runId,
      desc(table.createdAt),
    ),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    noteType: text("note_type").$type<NoteType>().notNull().default("manual"),
    title: text("title"),
    contentText: text("content_text"),
    contentJson: jsonb("content_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    isEditable: boolean("is_editable").notNull().default(true),
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
      name: "notes_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "notes_note_type_check",
      sql`${table.noteType} in ('manual', 'saved_response', 'generated')`,
    ),
    index("notes_workspace_updated_idx").on(
      table.workspaceId,
      desc(table.updatedAt),
    ),
    index("notes_thread_updated_idx").on(table.threadId, desc(table.updatedAt)),
  ],
);

export const noteSources = pgTable(
  "note_sources",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.sourceId] }),
    index("note_sources_source_idx").on(table.sourceId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    artifactType: text("artifact_type").$type<ArtifactType>().notNull(),
    status: text("status").$type<ArtifactStatus>().notNull().default("pending"),
    title: text("title"),
    promptText: text("prompt_text"),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    completedAt: timestamp("completed_at", {
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
      name: "artifacts_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "artifacts_artifact_type_check",
      sql`${table.artifactType} in ('report', 'slides', 'mindmap', 'podcast', 'audio_overview', 'video_overview', 'flashcards', 'quiz', 'table', 'infographic')`,
    ),
    check(
      "artifacts_status_check",
      sql`${table.status} in ('pending', 'running', 'ready', 'failed', 'archived')`,
    ),
    index("artifacts_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
    index("artifacts_thread_created_idx").on(
      table.threadId,
      desc(table.createdAt),
    ),
  ],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    parentVersionId: text("parent_version_id").references(
      (): AnyPgColumn => artifactVersions.id,
      {
        onDelete: "set null",
      },
    ),
    contentJson: jsonb("content_json")
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
      name: "artifact_versions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("artifact_versions_artifact_version_uq").on(
      table.artifactId,
      table.versionNo,
    ),
    check("artifact_versions_version_no_check", sql`${table.versionNo} > 0`),
    index("artifact_versions_artifact_created_idx").on(
      table.artifactId,
      desc(table.createdAt),
    ),
  ],
);

export const artifactSources = pgTable(
  "artifact_sources",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    chunkId: text("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    role: text("role").$type<ArtifactSourceRole>().notNull().default("input"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "artifact_sources_role_check",
      sql`${table.role} in ('input', 'evidence', 'output')`,
    ),
    index("artifact_sources_artifact_idx").on(table.artifactId),
    index("artifact_sources_source_idx").on(table.sourceId),
  ],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type").$type<ShareTargetType>().notNull(),
    targetId: text("target_id").notNull(),
    accessLevel: text("access_level")
      .$type<ShareAccessLevel>()
      .notNull()
      .default("viewer"),
    token: text("token").notNull(),
    isPublic: boolean("is_public").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "share_links_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }),
    check(
      "share_links_target_type_check",
      sql`${table.targetType} in ('thread', 'artifact', 'chat_view')`,
    ),
    check(
      "share_links_access_level_check",
      sql`${table.accessLevel} in ('viewer', 'editor')`,
    ),
    uniqueIndex("share_links_token_uq").on(table.token),
    index("share_links_target_idx").on(table.targetType, table.targetId),
    index("share_links_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
  ],
);

export const jobsAudit = pgTable(
  "jobs_audit",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      ,
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    jobType: text("job_type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    queueName: text("queue_name"),
    status: text("status").$type<JobStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    resultJson: jsonb("result_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorJson: jsonb("error_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "jobs_audit_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }),
    check(
      "jobs_audit_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check("jobs_audit_attempts_check", sql`${table.attempts} >= 0`),
    uniqueIndex("jobs_audit_team_idempotency_uq").on(
      table.teamId,
      table.idempotencyKey,
    ),
    index("jobs_audit_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
    index("jobs_audit_team_status_created_idx").on(
      table.teamId,
      table.status,
      desc(table.createdAt),
    ),
  ],
);

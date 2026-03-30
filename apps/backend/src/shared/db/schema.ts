import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
type SourceStatus = "created" | "indexed";
type MessageRole = "user" | "assistant" | "system";
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

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    organizationSlugUnique: uniqueIndex("workspaces_org_slug_uq").on(
      table.organizationId,
      table.slug,
    ),
  }),
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role")
      .$type<WorkspaceRole>()
      .notNull()
      .default("workspace_admin"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
    userIndex: index("workspace_memberships_user_idx").on(table.userId),
  }),
);

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    teamId: text("team_id").primaryKey(),
    planFamily: text("plan_family").$type<PlanFamily>().notNull(),
    cycleAnchorDay: integer("cycle_anchor_day").notNull().default(1),
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
  (table) => ({
    cycleAnchorDayCheck: check(
      "billing_accounts_cycle_anchor_day_check",
      sql`${table.cycleAnchorDay} between 1 and 28`,
    ),
    pagesLimitCheck: check(
      "billing_accounts_pages_limit_check",
      sql`${table.pagesLimit} >= 0`,
    ),
    pagesUsedCheck: check(
      "billing_accounts_pages_used_check",
      sql`${table.pagesUsed} >= 0`,
    ),
    monthlyGrantCheck: check(
      "billing_accounts_monthly_grant_check",
      sql`${table.monthlyCreditsGrant} >= 0`,
    ),
    monthlyBalanceCheck: check(
      "billing_accounts_monthly_balance_check",
      sql`${table.monthlyCreditsBalance} >= 0`,
    ),
    addOnBalanceCheck: check(
      "billing_accounts_add_on_balance_check",
      sql`${table.addOnCreditsBalance} >= 0`,
    ),
    reservedCheck: check(
      "billing_accounts_reserved_check",
      sql`${table.creditsReserved} >= 0`,
    ),
    consumedCheck: check(
      "billing_accounts_consumed_check",
      sql`${table.creditsConsumedThisCycle} >= 0`,
    ),
    softCapCheck: check(
      "billing_accounts_soft_cap_check",
      sql`${table.spendSoftCapUsd} is null or ${table.spendSoftCapUsd} >= 0`,
    ),
    hardCapCheck: check(
      "billing_accounts_hard_cap_check",
      sql`${table.spendHardCapUsd} is null or ${table.spendHardCapUsd} >= 0`,
    ),
    hardGteSoftCheck: check(
      "billing_accounts_hard_gte_soft_check",
      sql`${table.spendSoftCapUsd} is null or ${table.spendHardCapUsd} is null or ${table.spendHardCapUsd} >= ${table.spendSoftCapUsd}`,
    ),
    seatCountCheck: check(
      "billing_accounts_seat_count_check",
      sql`${table.seatCount} >= 1`,
    ),
  }),
);

export const usageLedgers = pgTable(
  "usage_ledgers",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
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
  (table) => ({
    eventTypeCheck: check(
      "usage_ledgers_event_type_check",
      sql`${table.eventType} in ('grant', 'reserve', 'consume', 'release', 'refund', 'expire', 'adjust')`,
    ),
    unitTypeCheck: check(
      "usage_ledgers_unit_type_check",
      sql`${table.unitType} in ('credit', 'page')`,
    ),
    teamCreatedIndex: index("usage_ledgers_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
    teamWorkspaceCreatedIndex: index(
      "usage_ledgers_team_workspace_created_idx",
    ).on(table.teamId, table.workspaceId, desc(table.createdAt)),
    teamIdempotencyUnique: uniqueIndex("usage_ledgers_team_idempotency_uq").on(
      table.teamId,
      table.idempotencyKey,
    ),
  }),
);

export const spendLimits = pgTable(
  "spend_limits",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
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
  (table) => ({
    softCapCheck: check(
      "spend_limits_soft_cap_check",
      sql`${table.softCapUsd} is null or ${table.softCapUsd} >= 0`,
    ),
    hardCapCheck: check(
      "spend_limits_hard_cap_check",
      sql`${table.hardCapUsd} is null or ${table.hardCapUsd} >= 0`,
    ),
    hardGteSoftCheck: check(
      "spend_limits_hard_gte_soft_check",
      sql`${table.softCapUsd} is null or ${table.hardCapUsd} is null or ${table.hardCapUsd} >= ${table.softCapUsd}`,
    ),
    teamScopeActorUnique: uniqueIndex("spend_limits_team_scope_user_uq").on(
      table.teamId,
      table.scope,
      sql`coalesce(${table.actorUserId}, '')`,
    ),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    provider: text("provider")
      .$type<BillingProvider>()
      .notNull()
      .default("none"),
    planFamily: text("plan_family").$type<PlanFamily>().notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
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
  (table) => ({
    teamUnique: unique("subscriptions_team_id_uq").on(table.teamId),
    externalSubscriptionUnique: uniqueIndex(
      "subscriptions_provider_external_subscription_uq",
    ).on(table.provider, table.externalSubscriptionId),
    providerCheck: check(
      "subscriptions_provider_check",
      sql`${table.provider} in ('none', 'creem', 'stripe', 'manual')`,
    ),
    statusCheck: check(
      "subscriptions_status_check",
      sql`${table.status} in ('inactive', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled', 'expired')`,
    ),
  }),
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
  (table) => ({
    providerEventUnique: uniqueIndex(
      "billing_webhook_events_provider_event_uq",
    ).on(table.provider, table.providerEventId),
    statusCheck: check(
      "billing_webhook_events_status_check",
      sql`${table.status} in ('received', 'processed', 'ignored', 'failed')`,
    ),
    providerCheck: check(
      "billing_webhook_events_provider_check",
      sql`${table.provider} in ('none', 'creem', 'stripe', 'manual')`,
    ),
    teamStatusReceivedIndex: index("billing_webhook_events_team_status_idx").on(
      table.teamId,
      table.status,
      desc(table.receivedAt),
    ),
    statusReceivedIndex: index("billing_webhook_events_status_received_idx").on(
      table.status,
      desc(table.receivedAt),
    ),
  }),
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
  (table) => ({
    alertKeyUnique: uniqueIndex("ops_alerts_alert_key_uq").on(table.alertKey),
    levelCheck: check(
      "ops_alerts_level_check",
      sql`${table.level} in ('warn', 'error', 'critical')`,
    ),
    statusCheck: check(
      "ops_alerts_status_check",
      sql`${table.status} in ('open', 'resolved')`,
    ),
    levelStatusTriggeredIndex: index(
      "ops_alerts_level_status_triggered_idx",
    ).on(table.level, table.status, desc(table.lastTriggeredAt)),
    sourceTriggeredIndex: index("ops_alerts_source_triggered_idx").on(
      table.source,
      desc(table.lastTriggeredAt),
    ),
  }),
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    contentText: text("content_text").notNull().default(""),
    status: text("status").$type<SourceStatus>().notNull().default("created"),
    estimatedPages: integer("estimated_pages"),
    parsedTokens: integer("parsed_tokens"),
    createdBy: text("created_by").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "sources_status_check",
      sql`${table.status} in ('created', 'indexed')`,
    ),
    estimatedPagesCheck: check(
      "sources_estimated_pages_check",
      sql`${table.estimatedPages} is null or ${table.estimatedPages} > 0`,
    ),
    parsedTokensCheck: check(
      "sources_parsed_tokens_check",
      sql`${table.parsedTokens} is null or ${table.parsedTokens} > 0`,
    ),
    teamWorkspaceCreatedIndex: index("sources_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
  }),
);

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    teamWorkspaceCreatedIndex: index("threads_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    createdBy: text("created_by"),
    model: text("model"),
    creditsConsumed: integer("credits_consumed"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      "messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'system')`,
    ),
    creditsConsumedCheck: check(
      "messages_credits_consumed_check",
      sql`${table.creditsConsumed} is null or ${table.creditsConsumed} >= 0`,
    ),
    threadCreatedIndex: index("messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    teamWorkspaceCreatedIndex: index("messages_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
  }),
);

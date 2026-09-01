import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { emptyJsonObject, type PlanFamily } from "./shared";
import { workspaces } from "./identity-workspace";

type LedgerEventType =
  "grant" | "reserve" | "consume" | "release" | "refund" | "expire" | "adjust";
type LedgerUnitType = "credit" | "page" | "seat";
type TopupUnitType = "credit" | "page";
type BillingOperationType =
  | "seat_change"
  | "cycle_renewal"
  | "plan_change"
  | "topup"
  | "usage"
  | "quota_adjustment";
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
type BillingOrderKind = "subscription" | "credit_topup" | "page_topup";
type BillingOrderStatus =
  | "pending"
  | "checkout_created"
  | "payment_confirmed"
  | "fulfilled"
  | "payment_failed"
  | "expired"
  | "fulfillment_failed";
type BillingOrderPaymentStatus =
  "unknown" | "unpaid" | "paid" | "failed" | "expired";

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    // Credits and pages are granted per-member: one row per (team_id, user_id).
    // A member's runs deduct from their own row; no shared team pool (谁问谁付).
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
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
    primaryKey({ columns: [table.teamId, table.userId] }),
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
    operationId: text("operation_id"),
    operationType: text("operation_type").$type<BillingOperationType>(),
    activityVisible: boolean("activity_visible").notNull().default(false),
    activityTitle: text("activity_title"),
    activitySummary: text("activity_summary"),
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
      sql`${table.unitType} in ('credit', 'page', 'seat')`,
    ),
    check(
      "usage_ledgers_operation_type_check",
      sql`${table.operationType} is null or ${table.operationType} in ('seat_change', 'cycle_renewal', 'plan_change', 'topup', 'usage', 'quota_adjustment')`,
    ),
    index("usage_ledgers_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
    index("usage_ledgers_team_activity_created_idx")
      .on(table.teamId, desc(table.createdAt))
      .where(sql`${table.activityVisible} = true`),
    index("usage_ledgers_team_workspace_created_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.createdAt),
    ),
    uniqueIndex("usage_ledgers_team_idempotency_uq").on(
      table.teamId,
      table.idempotencyKey,
    ),
    uniqueIndex("usage_ledgers_team_operation_visible_uq")
      .on(table.teamId, table.operationId)
      .where(
        sql`${table.activityVisible} = true and ${table.operationId} is not null`,
      ),
  ],
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

export const billingOrders = pgTable(
  "billing_orders",
  {
    id: text("id").primaryKey(),
    provider: text("provider").$type<BillingProvider>().notNull(),
    kind: text("kind").$type<BillingOrderKind>().notNull(),
    status: text("status")
      .$type<BillingOrderStatus>()
      .notNull()
      .default("pending"),
    paymentStatus: text("payment_status")
      .$type<BillingOrderPaymentStatus>()
      .notNull()
      .default("unknown"),
    userId: text("user_id").notNull(),
    teamId: text("team_id"),
    clientReferenceKey: text("client_reference_key"),
    planFamily: text("plan_family").$type<PlanFamily>(),
    billingInterval: text("billing_interval").$type<
      "monthly" | "yearly" | "unknown"
    >(),
    quantity: integer("quantity").notNull().default(1),
    unitType: text("unit_type").$type<TopupUnitType>(),
    unitAmount: integer("unit_amount"),
    grantedCredits: integer("granted_credits").notNull().default(0),
    grantedPages: integer("granted_pages").notNull().default(0),
    externalCheckoutId: text("external_checkout_id"),
    externalPaymentId: text("external_payment_id"),
    externalCustomerId: text("external_customer_id"),
    externalSubscriptionId: text("external_subscription_id"),
    externalProductId: text("external_product_id"),
    amountTotal: integer("amount_total"),
    currency: text("currency"),
    successUrl: text("success_url"),
    cancelUrl: text("cancel_url"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    fulfilledAt: timestamp("fulfilled_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    fulfillmentAttemptCount: integer("fulfillment_attempt_count")
      .notNull()
      .default(0),
    nextRetryAt: timestamp("next_retry_at", {
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
    uniqueIndex("billing_orders_provider_checkout_uq")
      .on(table.provider, table.externalCheckoutId)
      .where(sql`${table.externalCheckoutId} is not null`),
    uniqueIndex("billing_orders_user_reference_uq")
      .on(table.userId, table.clientReferenceKey)
      .where(sql`${table.clientReferenceKey} is not null`),
    index("billing_orders_user_status_created_idx").on(
      table.userId,
      table.status,
      desc(table.createdAt),
    ),
    index("billing_orders_team_status_created_idx").on(
      table.teamId,
      table.status,
      desc(table.createdAt),
    ),
    index("billing_orders_status_retry_idx").on(
      table.status,
      table.nextRetryAt,
    ),
    check(
      "billing_orders_provider_check",
      sql`${table.provider} in ('none', 'creem', 'stripe', 'manual')`,
    ),
    check(
      "billing_orders_kind_check",
      sql`${table.kind} in ('subscription', 'credit_topup', 'page_topup')`,
    ),
    check(
      "billing_orders_status_check",
      sql`${table.status} in ('pending', 'checkout_created', 'payment_confirmed', 'fulfilled', 'payment_failed', 'expired', 'fulfillment_failed')`,
    ),
    check(
      "billing_orders_payment_status_check",
      sql`${table.paymentStatus} in ('unknown', 'unpaid', 'paid', 'failed', 'expired')`,
    ),
    check(
      "billing_orders_plan_family_check",
      sql`${table.planFamily} is null or ${table.planFamily} in ('individual_free', 'individual_pro', 'team_standard', 'team_premium', 'enterprise_usage')`,
    ),
    check(
      "billing_orders_billing_interval_check",
      sql`${table.billingInterval} is null or ${table.billingInterval} in ('monthly', 'yearly', 'unknown')`,
    ),
    check(
      "billing_orders_unit_type_check",
      sql`${table.unitType} is null or ${table.unitType} in ('credit', 'page')`,
    ),
    check("billing_orders_quantity_check", sql`${table.quantity} >= 1`),
    check(
      "billing_orders_unit_amount_check",
      sql`${table.unitAmount} is null or ${table.unitAmount} > 0`,
    ),
    check(
      "billing_orders_granted_credits_check",
      sql`${table.grantedCredits} >= 0`,
    ),
    check(
      "billing_orders_granted_pages_check",
      sql`${table.grantedPages} >= 0`,
    ),
    check(
      "billing_orders_amount_total_check",
      sql`${table.amountTotal} is null or ${table.amountTotal} >= 0`,
    ),
    check(
      "billing_orders_attempt_count_check",
      sql`${table.fulfillmentAttemptCount} >= 0`,
    ),
    check(
      "billing_orders_subscription_shape_check",
      sql`${table.kind} <> 'subscription' or (${table.planFamily} in ('individual_pro', 'team_standard') and ${table.billingInterval} in ('monthly', 'yearly') and ${table.unitType} is null and ${table.unitAmount} is null and ${table.grantedCredits} = 0 and ${table.grantedPages} = 0)`,
    ),
    check(
      "billing_orders_topup_shape_check",
      sql`${table.kind} not in ('credit_topup', 'page_topup') or (${table.teamId} is not null and ${table.unitType} is not null and ${table.unitAmount} is not null and (${table.grantedCredits} > 0 or ${table.grantedPages} > 0))`,
    ),
    check(
      "billing_orders_credit_topup_shape_check",
      sql`${table.kind} <> 'credit_topup' or (${table.unitType} = 'credit' and ${table.grantedCredits} = ${table.unitAmount} * ${table.quantity} and ${table.grantedPages} = 0)`,
    ),
    check(
      "billing_orders_page_topup_shape_check",
      sql`${table.kind} <> 'page_topup' or (${table.unitType} = 'page' and ${table.grantedPages} = ${table.unitAmount} * ${table.quantity} and ${table.grantedCredits} = 0)`,
    ),
    check(
      "billing_orders_pro_team_required_check",
      sql`${table.planFamily} <> 'individual_pro' or ${table.teamId} is not null`,
    ),
    check(
      "billing_orders_team_checkout_no_org_check",
      sql`${table.planFamily} <> 'team_standard' or ${table.status} not in ('pending', 'checkout_created') or ${table.teamId} is null`,
    ),
  ],
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
    externalSubscriptionItemId: text("external_subscription_item_id"),
    externalProductId: text("external_product_id"),
    billingOrderId: text("billing_order_id"),
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
    index("subscriptions_billing_order_idx").on(table.billingOrderId),
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

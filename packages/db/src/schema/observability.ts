import { desc, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";
import { modelGatewayConfigs } from "./model-gateway";
import { messages, threads } from "./threads";

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
  "none" | "normalized" | "sdk_metadata" | "reconstructed" | "provider_wire";

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
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
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
    index("llm_traces_team_started_id_idx").on(
      table.teamId,
      table.startedAt,
      table.id,
    ),
    index("llm_traces_thread_started_idx").on(table.threadId, table.startedAt),
    index("llm_traces_message_idx").on(table.messageId),
    index("llm_traces_status_started_idx").on(table.status, table.startedAt),
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
    provider: text("provider"),
    providerModel: text("provider_model"),
    modelAlias: text("model_alias"),
    executionMode: text("execution_mode"),
    status: text("status")
      .$type<LlmObservationStatus>()
      .notNull()
      .default("running"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
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
    index("llm_spans_scope_trace_started_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.startedAt,
      table.id,
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
    index("llm_spans_provider_started_idx").on(table.provider, table.startedAt),
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
    provider: text("provider"),
    providerModel: text("provider_model"),
    resolvedProviderModel: text("resolved_provider_model"),
    modelAlias: text("model_alias"),
    profileAlias: text("profile_alias"),
    gatewayConfigId: text("gateway_config_id").references(
      () => modelGatewayConfigs.id,
      { onDelete: "set null" },
    ),
    executionMode: text("execution_mode"),
    keySource: text("key_source"),
    routeStrategy: text("route_strategy"),
    routeDecisionJson: jsonb("route_decision_json").$type<Record<
      string,
      unknown
    > | null>(),
    modelParametersJson: jsonb("model_parameters_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    inputJson: jsonb("input_json").$type<Record<string, unknown> | null>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown> | null>(),
    outputText: text("output_text"),
    finishReason: text("finish_reason"),
    reasoningText: text("reasoning_text"),
    providerFieldsJson: jsonb("provider_fields_json").$type<Record<
      string,
      unknown
    > | null>(),
    usageJson: jsonb("usage_json").$type<Record<string, unknown> | null>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    providerCostUsd: numeric("provider_cost_usd", {
      precision: 18,
      scale: 12,
    }),
    providerCostInlineUsd: numeric("provider_cost_inline_usd", {
      precision: 18,
      scale: 12,
    }),
    providerCostSettledUsd: numeric("provider_cost_settled_usd", {
      precision: 18,
      scale: 12,
    }),
    providerCostSource: text("provider_cost_source"),
    providerCostStatus: text("provider_cost_status"),
    costCurrency: text("cost_currency"),
    providerReceiptJson: jsonb("provider_receipt_json").$type<Record<
      string,
      unknown
    > | null>(),
    costReconciledAt: timestamp("cost_reconciled_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Populated only when providerCostStatus lands on 'reconcile_failed'
    // (all reconciliation attempts exhausted) — see
    // shared/model-gateway/provider-cost-reconciliation.ts. This is a known,
    // permanent operational gap: nothing rescans or retries these rows today;
    // recovery is a manual/product decision, not automated. These two fields
    // exist so ops can see why and when a row got stuck, not to enable any
    // automated remediation.
    providerCostReconcileFailureReason: text(
      "provider_cost_reconcile_failure_reason",
    ),
    providerCostReconcileFailedAt: timestamp(
      "provider_cost_reconcile_failed_at",
      { withTimezone: true, mode: "date" },
    ),
    normalizationJson: jsonb("normalization_json").$type<Record<
      string,
      unknown
    > | null>(),
    rawCaptureMode: text("raw_capture_mode")
      .$type<RawCaptureMode>()
      .notNull()
      .default("normalized"),
    providerRequestJson: jsonb("provider_request_json").$type<Record<
      string,
      unknown
    > | null>(),
    providerResponseJson: jsonb("provider_response_json").$type<Record<
      string,
      unknown
    > | null>(),
    providerRequestHeadersJson: jsonb(
      "provider_request_headers_json",
    ).$type<Record<string, unknown> | null>(),
    providerResponseHeadersJson: jsonb(
      "provider_response_headers_json",
    ).$type<Record<string, unknown> | null>(),
    providerStatusCode: integer("provider_status_code"),
    providerRequestId: text("provider_request_id"),
    rawCaptureError: text("raw_capture_error"),
    status: text("status")
      .$type<LlmObservationStatus>()
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
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
      "llm_generations_reasoning_tokens_check",
      sql`${table.reasoningTokens} is null or ${table.reasoningTokens} >= 0`,
    ),
    check(
      "llm_generations_cache_read_tokens_check",
      sql`${table.cacheReadTokens} is null or ${table.cacheReadTokens} >= 0`,
    ),
    check(
      "llm_generations_cache_write_tokens_check",
      sql`${table.cacheWriteTokens} is null or ${table.cacheWriteTokens} >= 0`,
    ),
    check(
      "llm_generations_provider_cost_check",
      sql`${table.providerCostUsd} is null or ${table.providerCostUsd} >= 0`,
    ),
    check(
      "llm_generations_provider_cost_inline_check",
      sql`${table.providerCostInlineUsd} is null or ${table.providerCostInlineUsd} >= 0`,
    ),
    check(
      "llm_generations_provider_cost_settled_check",
      sql`${table.providerCostSettledUsd} is null or ${table.providerCostSettledUsd} >= 0`,
    ),
    check(
      "llm_generations_provider_cost_source_check",
      sql`${table.providerCostSource} is null or ${table.providerCostSource} in ('provider_inline', 'provider_receipt', 'provider_estimated', 'price_book', 'temporary_minimum', 'legacy', 'missing')`,
    ),
    check(
      "llm_generations_provider_cost_status_check",
      sql`${table.providerCostStatus} is null or ${table.providerCostStatus} in ('pending', 'inline', 'settled', 'estimated', 'legacy', 'missing', 'reconcile_failed')`,
    ),
    check(
      "llm_generations_cost_currency_check",
      sql`${table.costCurrency} is null or ${table.costCurrency} = 'USD'`,
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
    index("llm_generations_scope_trace_started_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.traceId,
      table.startedAt,
      table.id,
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
    index("llm_generations_provider_resolved_model_started_idx").on(
      table.provider,
      table.resolvedProviderModel,
      table.startedAt,
    ),
    index("llm_generations_provider_request_idx").on(
      table.provider,
      table.providerRequestId,
    ),
    index("llm_generations_cost_status_ended_idx").on(
      table.providerCostStatus,
      table.endedAt,
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
    index("llm_feedback_scores_trace_idx").on(table.traceId, table.createdAt),
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

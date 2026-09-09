import { desc, sql } from "drizzle-orm";
import { messageRoleSchema } from "@sourceweft/contracts/messages";
import { threadRunStatusSchema } from "@sourceweft/contracts/stream";
import { workingFilePurposeSchema } from "@sourceweft/contracts/working-files";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject, sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";

type ThreadModelSettings = {
  llmProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
  llmModelAlias?: string | null;
  imageModelAlias?: string | null;
  visionModelAlias?: string | null;
};
type MessageRole = (typeof messageRoleSchema.options)[number];
type ThreadVisibility = "private" | "workspace" | "public_link";
/**
 * Domain enums live in @sourceweft/contracts so the wire schema, the column
 * type, and the CHECK constraint below cannot drift apart. The dependency only
 * goes db -> contracts; contracts must never import db, or the web bundle would
 * pull in drizzle/pg.
 */
type WorkingFilePurpose = (typeof workingFilePurposeSchema.options)[number];
type ChatThreadRunStatus = (typeof threadRunStatusSchema.options)[number];
type ChatThreadRunMode = "send" | "refresh" | "edit" | "resume";

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    executionTargetJson: jsonb("execution_target_json")
      .$type<{ kind: "cloud" } | { kind: "local"; deviceId: string }>()
      .notNull()
      .default(sql`'{"kind":"cloud"}'::jsonb`),
    modelSettingsJson: jsonb("model_settings_json")
      .$type<ThreadModelSettings>()
      .notNull()
      .default(emptyJsonObject),
    chatPreferencesJson: jsonb("chat_preferences_json")
      .$type<Record<string, unknown>>()
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
    check(
      "threads_chat_preferences_object_check",
      sql`jsonb_typeof(${table.chatPreferencesJson}) = 'object'`,
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
    teamId: text("team_id").notNull(),
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
    providerCostUsd: numeric("provider_cost_usd", { precision: 18, scale: 12 }),
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
      sql`${table.role} in (${sqlEnumList(messageRoleSchema.options)})`,
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
    index("messages_scope_thread_created_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      desc(table.createdAt),
      desc(table.id),
    ),
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

export const chatThreadRuns = pgTable(
  "chat_thread_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    userMessageId: text("user_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    assistantMessageId: text("assistant_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").$type<ChatThreadRunMode>().notNull(),
    jobId: text("job_id"),
    streamKey: text("stream_key").notNull(),
    status: text("status")
      .$type<ChatThreadRunStatus>()
      .notNull()
      .default("queued"),
    eventOffset: integer("event_offset").notNull().default(0),
    requestJson: jsonb("request_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    snapshotJson: jsonb("snapshot_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", {
      withTimezone: true,
      mode: "date",
    }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chat_thread_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "chat_thread_runs_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    check(
      "chat_thread_runs_status_check",
      sql`${table.status} in (${sqlEnumList(threadRunStatusSchema.options)})`,
    ),
    check(
      "chat_thread_runs_mode_check",
      sql`${table.mode} in ('send', 'refresh', 'edit', 'resume')`,
    ),
    check(
      "chat_thread_runs_event_offset_check",
      sql`${table.eventOffset} >= 0`,
    ),
    uniqueIndex("chat_thread_runs_idempotency_uq").on(
      table.teamId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("chat_thread_runs_thread_active_uq")
      .on(table.teamId, table.workspaceId, table.threadId)
      .where(
        sql`${table.status} in ('queued', 'running', 'cancel_requested', 'waiting_for_approval')`,
      ),
    index("chat_thread_runs_thread_status_created_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      table.status,
      desc(table.createdAt),
    ),
    index("chat_thread_runs_job_idx").on(table.jobId),
  ],
);

export const workingFiles = pgTable(
  "working_files",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
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
      sql`${table.path} ~ '^/workfiles/[^[:cntrl:]]+$' and ${table.path} not like '%..%' and ${table.path} not like '%~%' and ${table.path} not like '%//%'`,
    ),
    check(
      "working_files_purpose_check",
      sql`${table.purpose} is null or ${table.purpose} in (${sqlEnumList(workingFilePurposeSchema.options)})`,
    ),
    check("working_files_size_bytes_check", sql`${table.sizeBytes} >= 0`),
    index("working_files_thread_updated_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      desc(table.updatedAt),
    ),
  ],
);

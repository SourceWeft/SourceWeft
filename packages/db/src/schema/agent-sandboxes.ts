import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";
import { messages, threads } from "./threads";

type AgentSandboxStatus = "creating" | "ready" | "expired" | "closed" | "error";
type AgentSandboxOperationType =
  "prepare" | "execute" | "collect" | "create" | "close" | "cleanup";
type AgentSandboxOperationStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export const agentSandboxes = pgTable(
  "agent_sandboxes",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerSandboxId: text("provider_sandbox_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    status: text("status")
      .$type<AgentSandboxStatus>()
      .notNull()
      .default("creating"),
    networkPolicy: text("network_policy").notNull().default("default"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_sandboxes_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_sandboxes_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    check(
      "agent_sandboxes_status_check",
      sql`${table.status} in ('creating', 'ready', 'expired', 'closed', 'error')`,
    ),
    uniqueIndex("agent_sandboxes_provider_sandbox_uq").on(
      table.provider,
      table.providerSandboxId,
    ),
    index("agent_sandboxes_thread_status_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      table.status,
    ),
    index("agent_sandboxes_expires_idx").on(table.status, table.expiresAt),
    uniqueIndex("agent_sandboxes_one_active_per_thread_uq")
      .on(table.provider, table.teamId, table.workspaceId, table.threadId)
      .where(sql`${table.status} in ('creating', 'ready')`),
  ],
);

export const agentSandboxOperations = pgTable(
  "agent_sandbox_operations",
  {
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id").references(() => agentSandboxes.id, {
      onDelete: "set null",
    }),
    operationType: text("operation_type")
      .$type<AgentSandboxOperationType>()
      .notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id"),
    userId: text("user_id").notNull(),
    status: text("status").$type<AgentSandboxOperationStatus>().notNull(),
    requestJsonRedacted: jsonb("request_json_redacted")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    resultJsonRedacted: jsonb("result_json_redacted")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_sandbox_operations_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_sandbox_operations_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    check(
      "agent_sandbox_operations_type_check",
      sql`${table.operationType} in ('prepare', 'execute', 'collect', 'create', 'close', 'cleanup')`,
    ),
    check(
      "agent_sandbox_operations_status_check",
      sql`${table.status} in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check(
      "agent_sandbox_operations_duration_check",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
    index("agent_sandbox_operations_sandbox_created_idx").on(
      table.sandboxId,
      desc(table.createdAt),
    ),
    index("agent_sandbox_operations_thread_created_idx").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      desc(table.createdAt),
    ),
    index("agent_sandbox_operations_tool_call_idx").on(table.toolCallId),
    uniqueIndex("agent_sandbox_operations_success_tool_call_uq")
      .on(
        table.teamId,
        table.workspaceId,
        table.threadId,
        table.messageId,
        table.operationType,
        table.toolCallId,
      )
      .where(
        sql`${table.status} = 'succeeded' and ${table.messageId} is not null and ${table.toolCallId} is not null`,
      ),
    uniqueIndex("agent_sandbox_operations_active_tool_call_uq")
      .on(
        table.teamId,
        table.workspaceId,
        table.threadId,
        table.messageId,
        table.operationType,
        table.toolCallId,
      )
      .where(
        sql`${table.status} in ('running', 'succeeded') and ${table.messageId} is not null and ${table.toolCallId} is not null`,
      ),
  ],
);

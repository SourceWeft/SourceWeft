import {
  check,
  pgTable,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { threads } from "./threads";

export const localDeviceEnrollments = pgTable("local_device_enrollments", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id"),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const localDevices = pgTable(
  "local_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    remoteEnabled: boolean("remote_enabled").notNull().default(false),
    policyRevision: integer("policy_revision").notNull().default(1),
    workspaceBase: text("workspace_base"),
    tokenHash: text("token_hash").notNull(),
    connectionId: text("connection_id"),
    heartbeatAt: timestamp("heartbeat_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("local_devices_token_uq").on(table.tokenHash)],
);

export const localThreadBindings = pgTable("local_thread_bindings", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  deviceId: text("device_id")
    .notNull()
    .references(() => localDevices.id),
  userId: text("user_id").notNull(),
  localWorkspaceId: text("local_workspace_id"),
  folderId: text("folder_id"),
  workspacePath: text("workspace_path"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export const localToolInvocations = pgTable(
  "local_tool_invocations",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => localDevices.id),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    accessId: text("access_id"),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    deadline: timestamp("deadline", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "local_invocation_scope",
      sql`(${table.threadId} IS NOT NULL AND ${table.action} NOT IN ('folder.list', 'folder.read')) OR (${table.threadId} IS NULL AND ${table.action} IN ('folder.list', 'folder.read') AND ${table.payload} ? 'folderId' AND jsonb_typeof(${table.payload}->'folderId') = 'string' AND length(${table.payload}->>'folderId') > 0)`,
    ),
    index("local_invocations_device_status_idx").on(
      table.deviceId,
      table.status,
    ),
  ],
);

/** A browser session's authority is separate from the host's transport token. */
export const localDeviceAccess = pgTable("local_device_access", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  deviceId: text("device_id")
    .notNull()
    .references(() => localDevices.id),
  native: boolean("native").notNull().default(false),
  tokenHash: text("token_hash"),
  policyRevision: integer("policy_revision").notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});

export const localFolderGrants = pgTable("local_folder_grants", {
  id: text("id").primaryKey(),
  deviceId: text("device_id")
    .notNull()
    .references(() => localDevices.id),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});

export const localCreationContexts = pgTable("local_creation_contexts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  target: jsonb("target")
    .$type<import("@sourceweft/contracts").ThreadExecutionTarget>()
    .notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

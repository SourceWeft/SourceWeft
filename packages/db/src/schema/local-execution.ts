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
    /**
     * Outbound-network policy for commands run on this computer: `open` keeps
     * every public host reachable, `ask` raises an approval for an unknown
     * host while the command keeps running, `strict` never asks.
     */
    networkMode: text("network_mode").notNull().default("ask"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    // Last `status` report from the host. All null for hosts that never send one.
    platform: text("platform"),
    arch: text("arch"),
    shell: text("shell"),
    sandboxState: text("sandbox_state"),
    sandboxCode: text("sandbox_code"),
    sandboxReason: text("sandbox_reason"),
    sandboxRemedy: text("sandbox_remedy"),
    capabilities: jsonb("capabilities").$type<string[]>(),
    statusReportedAt: timestamp("status_reported_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("local_devices_token_uq").on(table.tokenHash),
    check(
      "local_devices_network_mode_check",
      sql`${table.networkMode} in ('open', 'ask', 'strict')`,
    ),
  ],
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

/**
 * One outbound connection the sandbox on a local computer asked permission
 * for. The row is the single source of truth between the instance that
 * received the device's `network.ask` frame and whichever instance serves the
 * user's answer, so nothing about a pending approval lives in process memory.
 * `(device_id, ask_id)` makes a re-sent ask idempotent.
 */
export const localNetworkRequests = pgTable(
  "local_network_requests",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => localToolInvocations.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => localDevices.id),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    askId: text("ask_id").notNull(),
    /**
     * `host`: may the command connect to this host. `request`: may it send
     * this write request (method + path, no query) to a host whose secret the
     * user bound read-only.
     */
    kind: text("kind").notNull().default("host"),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    method: text("method"),
    path: text("path"),
    /**
     * `request` rows only: the device saw a stored secret's value in the
     * request body, so the approval card says the secret would be sent.
     */
    secretInBody: boolean("secret_in_body").notNull().default(false),
    status: text("status").notNull().default("pending"),
    scope: text("scope"),
    reason: text("reason"),
    suggestedBy: text("suggested_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    /** Set once the decision frame reached the device. */
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("local_network_requests_device_ask_uq").on(
      table.deviceId,
      table.askId,
    ),
    index("local_network_requests_thread_status_idx").on(
      table.threadId,
      table.status,
    ),
    index("local_network_requests_device_delivered_idx").on(
      table.deviceId,
      table.deliveredAt,
    ),
    check(
      "local_network_requests_status_check",
      sql`${table.status} in ('pending', 'allowed', 'denied', 'expired')`,
    ),
    check(
      "local_network_requests_scope_check",
      sql`${table.scope} is null or (${table.scope} in ('once', 'always') and ${table.status} = 'allowed')`,
    ),
    check(
      "local_network_requests_kind_check",
      sql`${table.kind} in ('host', 'request')`,
    ),
    check(
      "local_network_requests_request_shape_check",
      sql`(${table.kind} = 'host' and ${table.method} is null and ${table.path} is null and not ${table.secretInBody}) or (${table.kind} = 'request' and ${table.method} is not null and char_length(${table.method}) <= 16 and (${table.path} is null or char_length(${table.path}) <= 200))`,
    ),
    check(
      "local_network_requests_port_check",
      sql`${table.port} between 1 and 65535`,
    ),
    check(
      "local_network_requests_resolved_check",
      sql`(${table.status} = 'pending') = (${table.resolvedAt} is null)`,
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

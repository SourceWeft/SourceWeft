import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject, type PlanFamily } from "./shared";

type WorkspaceRole = "workspace_admin" | "editor" | "viewer";
type WorkspaceMembershipSource = "direct" | "inherited" | "guest";

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
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

/**
 * One envelope-encryption data key per team. `wrapped_key` holds the team's
 * random 32-byte data key, base64-encoded and encrypted ("wrapped") with the
 * deployment master secret in the v1 `secrets.ts` payload format. Tenant-owned
 * ciphertexts (`v2:` payloads) are encrypted with the unwrapped data key —
 * see `apps/backend/src/shared/team-secrets.ts`. A team has exactly one
 * current key; rotation re-encrypts the team's rows and replaces
 * `wrapped_key`, stamping `rotated_at`.
 */
export const teamDataKeys = pgTable("team_data_keys", {
  teamId: text("team_id").primaryKey(),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
});

export const teamProfiles = pgTable(
  "team_profiles",
  {
    teamId: text("team_id").primaryKey(),
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

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id").primaryKey(),
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
      "user_settings_settings_object_check",
      sql`jsonb_typeof(${table.settings}) = 'object'`,
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
    userId: text("user_id").notNull(),
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
      sql`${table.source} in ('direct', 'inherited', 'guest')`,
    ),
  ],
);

/**
 * Pending invitations of an external collaborator (a "guest") to one
 * workspace. On accept, the invitee — who signs in with an ordinary account but
 * need not belong to the workspace's organization — gets a
 * `workspace_memberships` row with `source = 'guest'`. Accepted/revoked rows are
 * kept for the audit trail; a partial unique index keeps at most one live
 * invite per (workspace, email).
 */
export const workspaceGuestInvitations = pgTable(
  "workspace_guest_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("viewer"),
    token: text("token").notNull(),
    status: text("status")
      .$type<"pending" | "accepted" | "revoked">()
      .notNull()
      .default("pending"),
    invitedBy: text("invited_by"),
    acceptedUserId: text("accepted_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_guest_invitations_token_uq").on(table.token),
    index("workspace_guest_invitations_workspace_idx").on(table.workspaceId),
    check(
      "workspace_guest_invitations_role_check",
      sql`${table.role} in ('editor', 'viewer')`,
    ),
    check(
      "workspace_guest_invitations_status_check",
      sql`${table.status} in ('pending', 'accepted', 'revoked')`,
    ),
    uniqueIndex("workspace_guest_invitations_live_uq")
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
);

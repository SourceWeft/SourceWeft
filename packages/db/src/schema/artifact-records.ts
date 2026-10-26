import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { artifacts, artifactVersions } from "./artifacts";
import { workspaces } from "./identity-workspace";

type ArtifactRecordScope = "user" | "shared";
type ArtifactRecordApprovalCapability = "storage.shared";

/**
 * JSON records an HTML artifact page keeps through the host bridge.
 *
 * Data belongs to the artifact, not to a version, so it survives republishing;
 * which version may reach it is decided per request from that version's
 * immutable capability declaration. `user` rows belong to one viewer and
 * `shared` rows to everyone who can open the artifact. Owner and scope are
 * always derived from the session server-side, never taken from the page.
 */
export const artifactRecords = pgTable(
  "artifact_records",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    scope: text("scope").$type<ArtifactRecordScope>().notNull(),
    /** Required for `user` rows, null for `shared` rows. */
    ownerUserId: text("owner_user_id"),
    /** `kv` holds the key/value shorthand; any other name is a page collection. */
    collection: text("collection").notNull(),
    recordId: text("record_id").notNull(),
    data: jsonb("data").notNull(),
    /** UTF-8 bytes of the JSON text the page sent; quotas count this. */
    sizeBytes: integer("size_bytes").notNull(),
    etag: text("etag").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "artifact_records_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "artifact_records_scope_check",
      sql`${table.scope} in ('user', 'shared')`,
    ),
    check(
      "artifact_records_owner_check",
      sql`(${table.scope} = 'user') = (${table.ownerUserId} is not null)`,
    ),
    check("artifact_records_size_check", sql`${table.sizeBytes} >= 0`),
    // Also the prefix index every read and query starts from. NULLS NOT
    // DISTINCT makes shared rows (null owner) unique per key as well.
    unique("artifact_records_key_uq")
      .on(
        table.artifactId,
        table.scope,
        table.ownerUserId,
        table.collection,
        table.recordId,
      )
      .nullsNotDistinct(),
    index("artifact_records_data_gin").using(
      "gin",
      sql`${table.data} jsonb_path_ops`,
    ),
    index("artifact_records_owner_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
  ],
);

/**
 * A person's approval for one version to reach shared records. The agent can
 * declare `storage.shared`; only a workspace editor or admin, from their own
 * session, can make it take effect — and only for that exact version.
 */
export const artifactCapabilityApprovals = pgTable(
  "artifact_capability_approvals",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    capability: text("capability")
      .$type<ArtifactRecordApprovalCapability>()
      .notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Revocation keeps the row for audit; approving again clears it. */
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({
      name: "artifact_capability_approvals_pk",
      columns: [table.versionId, table.capability],
    }),
    check(
      "artifact_capability_approvals_capability_check",
      sql`${table.capability} in ('storage.shared')`,
    ),
    index("artifact_capability_approvals_artifact_idx").on(table.artifactId),
  ],
);

/** A viewer's informed consent to one approved version using shared records. */
export const artifactRecordConsents = pgTable(
  "artifact_record_consents",
  {
    userId: text("user_id").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    capability: text("capability")
      .$type<ArtifactRecordApprovalCapability>()
      .notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "artifact_record_consents_pk",
      columns: [table.userId, table.versionId, table.capability],
    }),
    check(
      "artifact_record_consents_capability_check",
      sql`${table.capability} in ('storage.shared')`,
    ),
    index("artifact_record_consents_artifact_idx").on(table.artifactId),
  ],
);

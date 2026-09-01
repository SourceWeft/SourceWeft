import { desc, sql } from "drizzle-orm";
import {
  artifactStatusSchema,
  artifactTypeSchema,
} from "@sourceweft/contracts/artifacts";
import {
  type AnyPgColumn,
  boolean,
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
import { emptyJsonObject, sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";
import { chunks, documents, sources } from "./sources";
import { threads } from "./threads";

/**
 * Row-level visibility for content that lives in a shared workspace.
 *
 * `private` — only the creator sees it, even from organization admins.
 * `workspace` — every member of the workspace sees it.
 *
 * A single-member workspace (every personal one, and every team workspace
 * before a second member joins) cannot observe the difference, which is why
 * the migration can default existing rows to `workspace` without exposing
 * anything: exposure needs a second member, and content that predates sharing
 * has none.
 */
type ContentVisibility = "private" | "workspace";
type ArtifactType = (typeof artifactTypeSchema.options)[number];
type ArtifactStatus = (typeof artifactStatusSchema.options)[number];
type ArtifactSourceRole = "input" | "evidence" | "output";
type ShareTargetType = "thread" | "artifact" | "chat_view";
type ShareAccessLevel = "viewer" | "editor";

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    artifactType: text("artifact_type").$type<ArtifactType>().notNull(),
    status: text("status").$type<ArtifactStatus>().notNull().default("pending"),
    /**
     * Pointer to the newest row in `artifact_versions` for this artifact, and
     * the token an edit run compare-and-swaps on.
     *
     * `artifact_versions` remains the sole authority on version numbers: this
     * column is written only from inside the same transaction that inserts the
     * new version, after the CAS, to the number that insert used. It exists
     * because status alone cannot tell two concurrent edits apart — both see
     * `ready` — so without it the unique index on
     * (artifact_id, version_no) is the only guard and the loser dies on an
     * opaque constraint violation instead of losing the race legibly.
     *
     * 0 means "no version yet": a `pending` row that has not published once.
     */
    currentVersionNo: integer("current_version_no").notNull().default(0),
    /**
     * Caller-supplied idempotency token ("the artifact for this request"),
     * lifted out of `payload_json` so it can be indexed. Nullable: most writes
     * do not ask for idempotency, and the column carries no meaning for them.
     *
     * Deliberately NOT unique. A unique constraint here would have to ignore
     * status, and a two-phase writer whose `open` is retried would then collide
     * with its own in-flight `pending` row. De-duplication is a lookup before
     * the write in the artifact writer instead.
     */
    requestKey: text("request_key"),
    title: text("title"),
    promptText: text("prompt_text"),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    previewStorageKey: text("preview_storage_key"),
    previewMetadataJson: jsonb("preview_metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    visibility: text("visibility")
      .$type<ContentVisibility>()
      .notNull()
      .default("workspace"),
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
      sql`${table.artifactType} in ('file', 'report', 'slides', 'mindmap', 'podcast', 'audio_overview', 'video_overview', 'video_presentation', 'flashcards', 'quiz', 'table', 'infographic', 'image')`,
    ),
    check(
      "artifacts_status_check",
      sql`${table.status} in (${sqlEnumList(artifactStatusSchema.options)})`,
    ),
    check(
      "artifacts_visibility_check",
      sql`${table.visibility} in ('private', 'workspace')`,
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
    check(
      "artifacts_current_version_no_check",
      sql`${table.currentVersionNo} >= 0`,
    ),
    // Serves the writer's idempotency lookup, which must run before any byte is
    // uploaded. Partial so it costs nothing for the overwhelming majority of
    // rows, which carry no request key.
    index("artifacts_workspace_type_request_key_idx")
      .on(table.workspaceId, table.artifactType, table.requestKey)
      .where(sql`${table.requestKey} is not null`),
  ],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
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
    teamId: text("team_id").notNull(),
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
    /**
     * Whether the public page opts out of search-engine indexing. A public
     * link is a deliberate publish, so the default is to allow indexing (SEO /
     * reach); this turns it off for sensitive one-off shares.
     */
    noindex: boolean("noindex").notNull().default(false),
    /** Unique-visitor-ish page views, incremented on each public read. */
    viewCount: integer("view_count").notNull().default(0),
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
    // Mirrors the contract: artifacts share today, `thread` is the reserved
    // slot for sharing conversations later (as immutable snapshots, not live
    // access). Anything else is surface no code path can produce.
    check(
      "share_links_target_type_check",
      sql`${table.targetType} in ('artifact', 'thread')`,
    ),
    // Anonymous link viewers are read-only; widen only when an editing share
    // actually ships end-to-end.
    check(
      "share_links_access_level_check",
      sql`${table.accessLevel} in ('viewer')`,
    ),
    uniqueIndex("share_links_token_uq").on(table.token),
    index("share_links_target_idx").on(table.targetType, table.targetId),
    index("share_links_team_created_idx").on(
      table.teamId,
      desc(table.createdAt),
    ),
    // At most one live (non-revoked) share per target — sharing is a toggle,
    // not an ever-growing list of links. Revoked rows are kept for audit and
    // do not count against the constraint.
    uniqueIndex("share_links_active_target_uq")
      .on(table.targetType, table.targetId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

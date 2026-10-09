import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./identity-workspace";
import { threads } from "./threads";

/**
 * Persistent sandbox volumes: the authoritative index of a thread's `/workspace`.
 * Data (chunks packed into immutable objects) lives in the object store under
 * `vol/<volume>/att/<attachment>/`; these tables hold the directory and the chunk index.
 */

type EntryKind = "f" | "d" | "l";
type AttachmentStatus =
  "active" | "superseded" | "rejected" | "quarantined" | "draining" | "retired";
/** [blake3 hex, raw length] pairs in file order. */
type ChunkList = Array<[string, number]>;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const sandboxVolumes = pgTable(
  "sandbox_volumes",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default("primary"),
    /** Monotonic version: every applied manifest and every rollback advances it by one. */
    headSeq: bigint("head_seq", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    logicalBytes: bigint("logical_bytes", { mode: "number" })
      .notNull()
      .default(0),
    storedBytes: bigint("stored_bytes", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "sandbox_volumes_thread_workspace_team_fk",
      columns: [table.threadId, table.workspaceId, table.teamId],
      foreignColumns: [threads.id, threads.workspaceId, threads.teamId],
    }).onDelete("cascade"),
    uniqueIndex("sandbox_volumes_thread_uq").on(
      table.teamId,
      table.workspaceId,
      table.threadId,
      table.namespace,
    ),
  ],
);

export const sandboxVolumeEntries = pgTable(
  "sandbox_volume_entries",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind").$type<EntryKind>().notNull(),
    mode: integer("mode").notNull(),
    mtimeNs: bigint("mtime_ns", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    linkTarget: text("link_target"),
    chunks: jsonb("chunks")
      .$type<ChunkList>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Sequence number of the manifest that produced this version of the entry. */
    seq: bigint("seq", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.volumeId, table.path] }),
    check(
      "sandbox_volume_entries_kind_check",
      sql`${table.kind} in ('f', 'd', 'l')`,
    ),
    // Bytewise ~>~/~<~ range predicates use text_pattern_ops without locale-sensitive sibling matching.
    index("sandbox_volume_entries_path_idx").on(
      table.volumeId,
      sql`${table.path} text_pattern_ops`,
    ),
  ],
);

export const sandboxVolumeChunks = pgTable(
  "sandbox_volume_chunks",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    /** BLAKE3 of the raw chunk content (32 bytes). */
    chunkId: bytea("chunk_id").notNull(),
    /** Pack key relative to the volume prefix, e.g. `att/<attachment>/p/000003`. */
    packKey: text("pack_key").notNull(),
    off: bigint("off", { mode: "number" }).notNull(),
    compressedLength: integer("compressed_length").notNull(),
    rawLength: integer("raw_length").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.volumeId, table.chunkId] }),
    index("sandbox_volume_chunks_pack_idx").on(table.volumeId, table.packKey),
  ],
);

export const sandboxVolumePacks = pgTable(
  "sandbox_volume_packs",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    packKey: text("pack_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.volumeId, table.packKey] })],
);

export const sandboxVolumeAttachments = pgTable(
  "sandbox_volume_attachments",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    /** Provider sandbox id the attachment was made for; informational. */
    sandboxId: text("sandbox_id"),
    /** Head of the volume when the attachment was created. */
    baseSeq: bigint("base_seq", { mode: "number" }).notNull(),
    /** Last sequence this actor durably committed; initialized to its restore base. */
    lastAppliedSeq: bigint("last_applied_seq", { mode: "number" }).notNull(),
    /** Container identity observed at attach time; manifests must carry the same. */
    bootId: text("boot_id"),
    /** A rejected chain starts a new epoch: new manifest slots, same attachment. */
    epoch: integer("epoch").notNull().default(0),
    status: text("status")
      .$type<AttachmentStatus>()
      .notNull()
      .default("active"),
    quarantineReason: text("quarantine_reason"),
    supervisorNonce: text("supervisor_nonce"),
    drainId: text("drain_id"),
    /** Only the SHA-256 digest is stored; the scoped bearer token is returned once to the bootstrap caller. */
    controlTokenHash: text("control_token_hash"),
    controlExpiresAt: timestamp("control_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Highest pack index and manifest seq for which slots were issued, and when they expire. */
    slotsUntilPack: integer("slots_until_pack").notNull().default(0),
    slotsUntilSeq: bigint("slots_until_seq", { mode: "number" })
      .notNull()
      .default(0),
    slotsExpireAt: timestamp("slots_expire_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "sandbox_volume_attachments_status_check",
      sql`${table.status} in ('active', 'superseded', 'rejected', 'quarantined', 'draining', 'retired')`,
    ),
    uniqueIndex("sandbox_volume_attachments_one_writer_uq")
      .on(table.volumeId)
      .where(sql`${table.status} in ('active', 'draining', 'quarantined')`),
    index("sandbox_volume_attachments_volume_idx").on(
      table.volumeId,
      table.status,
    ),
  ],
);

/** Previous versions of modified or deleted entries: nothing a commit does is destructive. */
export const sandboxVolumeEntryVersions = pgTable(
  "sandbox_volume_entry_versions",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind").$type<EntryKind>().notNull(),
    mode: integer("mode").notNull(),
    mtimeNs: bigint("mtime_ns", { mode: "bigint" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    linkTarget: text("link_target"),
    chunks: jsonb("chunks").$type<ChunkList>().notNull(),
    /** The version was current for seq in [fromSeq, toSeq). */
    fromSeq: bigint("from_seq", { mode: "number" }).notNull(),
    toSeq: bigint("to_seq", { mode: "number" }).notNull(),
  },
  (table) => [
    index("sandbox_volume_entry_versions_to_seq_idx").on(
      table.volumeId,
      table.toSeq,
    ),
    index("sandbox_volume_entry_versions_path_idx").on(
      table.volumeId,
      table.path,
    ),
  ],
);

export const sandboxVolumeRejects = pgTable(
  "sandbox_volume_rejects",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("sandbox_volume_rejects_volume_idx").on(
      table.volumeId,
      table.createdAt,
    ),
  ],
);

/** Durable provenance for idempotent application across hosts and response loss. */
export const sandboxVolumeCommits = pgTable(
  "sandbox_volume_commits",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    attachmentId: text("attachment_id").notNull(),
    epoch: integer("epoch").notNull(),
    manifestKey: text("manifest_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.volumeId, table.seq] })],
);

/** Conservative two-phase object deletion. Rows survive failed network deletes for retry. */
export const sandboxVolumeGcCandidates = pgTable(
  "sandbox_volume_gc_candidates",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    packKey: text("pack_key").notNull(),
    state: text("state")
      .$type<"pending" | "deleting" | "deleted">()
      .notNull()
      .default("pending"),
    notBefore: timestamp("not_before", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.volumeId, table.packKey] }),
    index("sandbox_volume_gc_due_idx").on(table.state, table.notBefore),
    check(
      "sandbox_volume_gc_state_check",
      sql`${table.state} in ('pending','deleting','deleted')`,
    ),
  ],
);

/** Durable internal drain fence. Only trusted host lifecycle code may submit the stop proof. */
export const sandboxVolumeDrains = pgTable(
  "sandbox_volume_drains",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => sandboxVolumeAttachments.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    bootId: text("boot_id").notNull(),
    supervisorNonce: text("supervisor_nonce").notNull(),
    recoveryControllerNonce: text("recovery_controller_nonce"),
    reason: text("reason").notNull(),
    status: text("status")
      .$type<"draining" | "retired">()
      .notNull()
      .default("draining"),
    stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
    confirmedSeq: bigint("confirmed_seq", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("sandbox_volume_drains_attachment_uq").on(table.attachmentId),
    check(
      "sandbox_volume_drains_status_check",
      sql`${table.status} in ('draining','retired')`,
    ),
  ],
);

export const sandboxVolumeExecutionPermits = pgTable(
  "sandbox_volume_execution_permits",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => sandboxVolumeAttachments.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    writerKind: text("writer_kind")
      .$type<"external" | "supervised">()
      .notNull()
      .default("external"),
    status: text("status")
      .$type<"active" | "released">()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("sandbox_volume_execution_permits_one_active_uq")
      .on(table.volumeId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("sandbox_volume_execution_permits_operation_uq").on(
      table.attachmentId,
      table.operationId,
    ),
    index("sandbox_volume_execution_permits_active_idx").on(
      table.attachmentId,
      table.status,
    ),
    check(
      "sandbox_volume_execution_permits_writer_kind_check",
      sql`${table.writerKind} in ('external','supervised')`,
    ),
    check(
      "sandbox_volume_execution_permits_status_check",
      sql`${table.status} in ('active','released')`,
    ),
  ],
);

/** Immutable recovery evidence and unknown-operation audit; never an execution-success receipt. */
export const sandboxVolumeRecoveries = pgTable(
  "sandbox_volume_recoveries",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => sandboxVolumeAttachments.id, { onDelete: "cascade" }),
    drainId: text("drain_id").references(() => sandboxVolumeDrains.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").$type<"supervisor" | "provider_absent">().notNull(),
    operationId: text("operation_id").notNull(),
    previousSupervisorNonce: text("previous_supervisor_nonce"),
    supervisorNonce: text("supervisor_nonce"),
    journalDigest: text("journal_digest"),
    confirmedSeq: bigint("confirmed_seq", { mode: "number" }).notNull(),
    unresolvedOperations: jsonb("unresolved_operations")
      .$type<
        Array<{
          permitId: string;
          operationId: string;
          writerKind: "external" | "supervised";
          outcome: "unknown" | "not_started";
        }>
      >()
      .notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, string | boolean>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sandbox_volume_recoveries_controller_uq")
      .on(table.attachmentId, table.supervisorNonce)
      .where(sql`${table.kind} = 'supervisor'`),
    uniqueIndex("sandbox_volume_recoveries_predecessor_uq")
      .on(table.attachmentId, table.previousSupervisorNonce)
      .where(sql`${table.kind} = 'supervisor'`),
    uniqueIndex("sandbox_volume_recoveries_operation_uq").on(
      table.attachmentId,
      table.kind,
      table.operationId,
    ),
    check(
      "sandbox_volume_recoveries_kind_check",
      sql`${table.kind} in ('supervisor','provider_absent')`,
    ),
  ],
);

/** Durable physical-copy reservations; unknown external results remain charged and pinned. */
export const sandboxVolumeObjectReservations = pgTable(
  "sandbox_volume_object_reservations",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => sandboxVolumes.id, { onDelete: "cascade" }),
    packKey: text("pack_key").notNull(),
    sourceKey: text("source_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    state: text("state")
      .$type<"pending" | "complete">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.volumeId, table.packKey] }),
    index("sandbox_volume_object_reservations_source_idx").on(
      table.volumeId,
      table.sourceKey,
      table.state,
    ),
    index("sandbox_volume_object_reservations_pending_idx").on(
      table.volumeId,
      table.state,
      table.createdAt,
    ),
    check(
      "sandbox_volume_object_reservations_state_check",
      sql`${table.state} in ('pending','complete')`,
    ),
    check(
      "sandbox_volume_object_reservations_size_check",
      sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 67108864`,
    ),
    check(
      "sandbox_volume_object_reservations_key_check",
      sql`${table.packKey} <> ${table.sourceKey}`,
    ),
  ],
);

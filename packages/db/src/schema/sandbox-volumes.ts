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
type AttachmentStatus = "active" | "superseded" | "rejected";
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
    // text_pattern_ops makes `path > 'p/' and path < 'p0'` (every descendant of p) an index range scan.
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
    /** Container identity observed at attach time; manifests must carry the same. */
    bootId: text("boot_id"),
    /** A rejected chain starts a new epoch: new manifest slots, same attachment. */
    epoch: integer("epoch").notNull().default(0),
    status: text("status")
      .$type<AttachmentStatus>()
      .notNull()
      .default("active"),
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
      sql`${table.status} in ('active', 'superseded', 'rejected')`,
    ),
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

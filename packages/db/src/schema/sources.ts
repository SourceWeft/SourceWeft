import { desc, sql } from "drizzle-orm";
import {
  sourceDocumentStatusSchema,
  sourceIngestKindSchema,
  sourceStatusSchema,
  sourceTypeSchema,
} from "@sourceweft/contracts/sources";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject, pgVector, sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";
import { connectorSyncRuns, sourceConnectors } from "./mcp-connectors";
import { modelGatewayProfiles } from "./model-gateway";

type SourceStatus = (typeof sourceStatusSchema.options)[number];
type SourceIngestKind = (typeof sourceIngestKindSchema.options)[number];
type SourceType = (typeof sourceTypeSchema.options)[number];
type DocumentStatus = (typeof sourceDocumentStatusSchema.options)[number];

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ingestKind: text("ingest_kind")
      .$type<SourceIngestKind>()
      .notNull()
      .default("manual_upload"),
    sourceType: text("source_type")
      .$type<SourceType>()
      .notNull()
      .default("manual_upload"),
    connectorId: text("connector_id").references(() => sourceConnectors.id),
    syncRunId: text("sync_run_id").references(() => connectorSyncRuns.id),
    parentSourceId: text("parent_source_id"),
    title: text("title").notNull(),
    contentText: text("content_text").notNull().default(""),
    externalId: text("external_id"),
    externalUri: text("external_uri"),
    externalUpdatedAt: timestamp("external_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    contentHash: text("content_hash"),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    parserVersion: text("parser_version"),
    parsingConfig: jsonb("parsing_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    status: text("status").$type<SourceStatus>().notNull().default("created"),
    estimatedPages: integer("estimated_pages"),
    parsedTokens: integer("parsed_tokens"),
    errorJson: jsonb("error_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdBy: text("created_by"),
    indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "sources_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    unique("sources_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "sources_status_check",
      sql`${table.status} in (${sqlEnumList(sourceStatusSchema.options)})`,
    ),
    check(
      "sources_ingest_kind_check",
      sql`${table.ingestKind} in (${sqlEnumList(sourceIngestKindSchema.options)})`,
    ),
    check(
      "sources_source_type_check",
      sql`${table.sourceType} in (${sqlEnumList(sourceTypeSchema.options)})`,
    ),
    check(
      "sources_connector_requirement_check",
      sql`(${table.ingestKind} = 'connector' and ${table.connectorId} is not null) or (${table.ingestKind} <> 'connector' and ${table.connectorId} is null)`,
    ),
    check(
      "sources_estimated_pages_check",
      sql`${table.estimatedPages} is null or ${table.estimatedPages} > 0`,
    ),
    check(
      "sources_parsed_tokens_check",
      sql`${table.parsedTokens} is null or ${table.parsedTokens} > 0`,
    ),
    check(
      "sources_size_bytes_check",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    uniqueIndex("sources_connector_external_id_uq")
      .on(table.connectorId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    index("sources_team_workspace_status_updated_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
      desc(table.updatedAt),
    ),
    index("sources_team_workspace_updated_id_idx").on(
      table.teamId,
      table.workspaceId,
      desc(table.updatedAt),
      desc(table.id),
    ),
    index("sources_team_workspace_parent_idx").on(
      table.teamId,
      table.workspaceId,
      table.parentSourceId,
    ),
    index("sources_team_workspace_parent_updated_id_idx").on(
      table.teamId,
      table.workspaceId,
      table.parentSourceId,
      desc(table.updatedAt),
      desc(table.id),
    ),
    index("sources_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);

export const sourceRevisions = pgTable(
  "source_revisions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    revisionNo: integer("revision_no").notNull(),
    contentHash: text("content_hash"),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    externalUpdatedAt: timestamp("external_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    parserVersion: text("parser_version"),
    isLatest: boolean("is_latest").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "source_revisions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "source_revisions_source_workspace_team_fk",
      columns: [table.sourceId, table.workspaceId, table.teamId],
      foreignColumns: [sources.id, sources.workspaceId, sources.teamId],
    }).onDelete("cascade"),
    uniqueIndex("source_revisions_source_revision_uq").on(
      table.sourceId,
      table.revisionNo,
    ),
    uniqueIndex("source_revisions_source_latest_uq")
      .on(table.sourceId)
      .where(sql`${table.isLatest} = true`),
    index("source_revisions_source_latest_idx").on(
      table.sourceId,
      table.isLatest,
      desc(table.createdAt),
    ),
    check("source_revisions_revision_no_check", sql`${table.revisionNo} > 0`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id").references(
      () => sourceRevisions.id,
    ),
    title: text("title"),
    language: text("language"),
    contentText: text("content_text").notNull(),
    tokenCount: integer("token_count"),
    charCount: integer("char_count"),
    status: text("status").$type<DocumentStatus>().notNull().default("pending"),
    documentMetadata: jsonb("document_metadata")
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
    foreignKey({
      name: "documents_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "documents_source_workspace_team_fk",
      columns: [table.sourceId, table.workspaceId, table.teamId],
      foreignColumns: [sources.id, sources.workspaceId, sources.teamId],
    }).onDelete("cascade"),
    unique("documents_id_workspace_team_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
    ),
    check(
      "documents_status_check",
      sql`${table.status} in ('pending', 'processing', 'ready', 'failed')`,
    ),
    check(
      "documents_token_count_check",
      sql`${table.tokenCount} is null or ${table.tokenCount} >= 0`,
    ),
    check(
      "documents_char_count_check",
      sql`${table.charCount} is null or ${table.charCount} >= 0`,
    ),
    index("documents_source_idx").on(table.sourceId),
    index("documents_workspace_updated_idx").on(
      table.workspaceId,
      desc(table.updatedAt),
    ),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkNo: integer("chunk_no").notNull(),
    content: text("content").notNull(),
    headingPath: text("heading_path"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    language: text("language"),
    searchParts: text("search_parts")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    chunkMetadata: jsonb("chunk_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chunks_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "chunks_document_workspace_team_fk",
      columns: [table.documentId, table.workspaceId, table.teamId],
      foreignColumns: [documents.id, documents.workspaceId, documents.teamId],
    }).onDelete("cascade"),
    uniqueIndex("chunks_document_chunk_no_uq").on(
      table.documentId,
      table.chunkNo,
    ),
    check("chunks_chunk_no_check", sql`${table.chunkNo} >= 0`),
    check(
      "chunks_offsets_check",
      sql`${table.startOffset} is null or ${table.endOffset} is null or ${table.startOffset} <= ${table.endOffset}`,
    ),
    index("chunks_workspace_document_chunk_idx").on(
      table.workspaceId,
      table.documentId,
      table.chunkNo,
    ),
    index("chunks_source_chunk_idx").on(table.sourceId, table.chunkNo),
  ],
);

export const chunkEmbeddings = pgTable(
  "chunk_embeddings",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    embeddingProfileId: text("embedding_profile_id")
      .notNull()
      .references(() => modelGatewayProfiles.id, { onDelete: "cascade" }),
    modelAlias: text("model_alias").notNull(),
    dim: integer("dim").notNull(),
    embedding: pgVector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chunk_embeddings_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("chunk_embeddings_chunk_profile_uq").on(
      table.chunkId,
      table.embeddingProfileId,
    ),
    check(
      "chunk_embeddings_dim_check",
      sql`${table.dim} > 0 and ${table.dim} <= 2000`,
    ),
    index("chunk_embeddings_workspace_profile_created_idx").on(
      table.workspaceId,
      table.embeddingProfileId,
      desc(table.createdAt),
    ),
    index("chunk_embeddings_chunk_created_idx").on(
      table.chunkId,
      desc(table.createdAt),
    ),
  ],
);

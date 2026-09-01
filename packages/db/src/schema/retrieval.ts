import { desc, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
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
import { modelGatewayProfiles } from "./model-gateway";
import { chunks, documents, sources } from "./sources";
import { messages, threads } from "./threads";

type RetrievalStage = "bm25" | "vector" | "rrf" | "rerank";
type RetrievalHitType = "chunk" | "document";
type RetrievalVectorStrategy = "ann_hnsw" | "exact_vector" | "bm25_only";

export const citations = pgTable(
  "citations",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    chunkId: text("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    citationKey: text("citation_key").notNull(),
    quoteText: text("quote_text"),
    startChar: integer("start_char"),
    endChar: integer("end_char"),
    rank: integer("rank"),
    score: doublePrecision("score"),
    externalUri: text("external_uri"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "citations_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("citations_message_key_uq").on(
      table.messageId,
      table.citationKey,
    ),
    check(
      "citations_rank_check",
      sql`${table.rank} is null or ${table.rank} > 0`,
    ),
    check(
      "citations_position_check",
      sql`${table.startChar} is null or ${table.endChar} is null or ${table.startChar} <= ${table.endChar}`,
    ),
    check(
      "citations_target_check",
      sql`${table.chunkId} is not null or ${table.externalUri} is not null`,
    ),
    index("citations_message_rank_idx").on(table.messageId, table.rank),
    index("citations_chunk_idx").on(table.chunkId),
    index("citations_source_document_idx").on(table.sourceId, table.documentId),
  ],
);

export const retrievalRuns = pgTable(
  "retrieval_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    embeddingProfileId: text("embedding_profile_id").references(
      () => modelGatewayProfiles.id,
      {
        onDelete: "set null",
      },
    ),
    queryText: text("query_text").notNull(),
    embedModelAlias: text("embed_model_alias"),
    rerankModelAlias: text("rerank_model_alias"),
    vectorStrategyUsed: text(
      "vector_strategy_used",
    ).$type<RetrievalVectorStrategy>(),
    annIndexUsed: text("ann_index_used"),
    bm25TopK: integer("bm25_top_k"),
    vectorTopK: integer("vector_top_k"),
    rrfK: integer("rrf_k"),
    prefilterCount: integer("prefilter_count"),
    candidateCount: integer("candidate_count"),
    finalResultCount: integer("final_result_count"),
    latencyMs: integer("latency_ms"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "retrieval_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "retrieval_runs_vector_strategy_used_check",
      sql`${table.vectorStrategyUsed} is null or ${table.vectorStrategyUsed} in ('ann_hnsw', 'exact_vector', 'bm25_only')`,
    ),
    check(
      "retrieval_runs_bm25_top_k_check",
      sql`${table.bm25TopK} is null or ${table.bm25TopK} > 0`,
    ),
    check(
      "retrieval_runs_vector_top_k_check",
      sql`${table.vectorTopK} is null or ${table.vectorTopK} > 0`,
    ),
    check(
      "retrieval_runs_rrf_k_check",
      sql`${table.rrfK} is null or ${table.rrfK} > 0`,
    ),
    check(
      "retrieval_runs_prefilter_count_check",
      sql`${table.prefilterCount} is null or ${table.prefilterCount} >= 0`,
    ),
    check(
      "retrieval_runs_candidate_count_check",
      sql`${table.candidateCount} is null or ${table.candidateCount} >= 0`,
    ),
    check(
      "retrieval_runs_final_result_count_check",
      sql`${table.finalResultCount} is null or ${table.finalResultCount} >= 0`,
    ),
    check(
      "retrieval_runs_latency_ms_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    index("retrieval_runs_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_thread_created_idx").on(
      table.threadId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_message_created_idx").on(
      table.messageId,
      desc(table.createdAt),
    ),
    index("retrieval_runs_profile_created_idx").on(
      table.embeddingProfileId,
      desc(table.createdAt),
    ),
  ],
);

export const retrievalHits = pgTable(
  "retrieval_hits",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => retrievalRuns.id, { onDelete: "cascade" }),
    sourceStage: text("source_stage").$type<RetrievalStage>().notNull(),
    hitType: text("hit_type").$type<RetrievalHitType>().notNull(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    chunkId: text("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    rank: integer("rank").notNull(),
    score: doublePrecision("score"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "retrieval_hits_source_stage_check",
      sql`${table.sourceStage} in ('bm25', 'vector', 'rrf', 'rerank')`,
    ),
    check(
      "retrieval_hits_hit_type_check",
      sql`${table.hitType} in ('chunk', 'document')`,
    ),
    check("retrieval_hits_rank_check", sql`${table.rank} > 0`),
    index("retrieval_hits_run_stage_rank_idx").on(
      table.runId,
      table.sourceStage,
      table.rank,
    ),
    index("retrieval_hits_run_created_idx").on(
      table.runId,
      desc(table.createdAt),
    ),
  ],
);

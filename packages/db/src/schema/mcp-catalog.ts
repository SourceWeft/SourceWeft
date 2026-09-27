import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  catalogAnalysisColumns,
  catalogAnalysisConstraints,
  catalogOverviewColumns,
  catalogOverviewConstraints,
  type CatalogClassificationOutcome,
} from "./catalog-overview";

// ---------------------------------------------------------------------------
// MCP catalog (publisher side). Migrated from the retired sourceweft-api
// service so the catalog lives in the main app database. We are a downstream
// discovery catalog: rows point to public GitHub repos, sourced by federating
// upstream registries (origin=upstream) or direct submission
// (origin=submitted). No per-manifest signing (registry is the trust anchor).
// Owned by `modules/market`; skills have their own `skill_*` tables.
// ---------------------------------------------------------------------------

type McpServerStatus =
  "draft" | "reviewing" | "published" | "unlisted" | "archived";
type McpServerVisibility = "public" | "private" | "internal";
type McpServerVersionOrigin = "upstream" | "submitted";
type McpServerCategoriesSetBy = "auto" | "ai" | "admin";
type McpServerReadmeStatus =
  "pending" | "ok" | "not_found" | "too_large" | "unsupported_host" | "error";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").$type<McpServerStatus>().notNull(),
    visibility: text("visibility").$type<McpServerVisibility>().notNull(),
    owner: text("owner"),
    sourceUrl: text("source_url"),
    repoUrl: text("repo_url"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Facets promoted out of metadataJson so listing can filter/sort/paginate in
    // SQL instead of scanning a capped window of rows in memory. Kept in sync by
    // the upsert; derived from the same manifest metadata mapItemRow reads.
    transport: text("transport"),
    official: boolean("official").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    desktopOnly: boolean("desktop_only").notNull().default(false),
    runtime: text("runtime"),
    // Category ownership, as on `skill_definitions`: 'auto' = rewritten by
    // every federation/submission upsert, 'ai' = set by the AI overview,
    // 'admin' = chosen by a market admin. Only 'auto' is ever rewritten.
    categoriesSetBy: text("categories_set_by")
      .$type<McpServerCategoriesSetBy>()
      .notNull()
      .default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("mcp_servers_identifier_uq").on(table.identifier),
    // Serves the default catalog browse + keyset pagination: filter by
    // status/visibility, order by publishedAt desc then id desc.
    index("mcp_servers_browse_idx").on(
      table.status,
      table.visibility,
      desc(table.publishedAt),
      desc(table.id),
    ),
    check(
      "mcp_servers_status_check",
      sql`${table.status} in ('draft', 'reviewing', 'published', 'unlisted', 'archived')`,
    ),
    check(
      "mcp_servers_visibility_check",
      sql`${table.visibility} in ('public', 'private', 'internal')`,
    ),
    check(
      "mcp_servers_categories_set_by_check",
      sql`${table.categoriesSetBy} in ('auto', 'ai', 'admin')`,
    ),
  ],
);

export const mcpServerVersions = pgTable(
  "mcp_server_versions",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status").$type<McpServerStatus>().notNull(),
    // How this version entered the catalog, and which upstream/source produced
    // it (e.g. "registry.modelcontextprotocol.io", "github", "submission").
    origin: text("origin")
      .$type<McpServerVersionOrigin>()
      .notNull()
      .default("submitted"),
    source: text("source"),
    manifestJson: jsonb("manifest_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The author's README for this version, as GitHub's README API (or the
    // submission's own repository read) returned it. Written by the README
    // fetch job and the submission path only: a federation re-sync never
    // touches the `readme_*` columns or `readme_md`.
    readmeMd: text("readme_md"),
    // Where the README came from: its repository-relative path, the commit it
    // was pinned to, and the sha256 of its bytes.
    readmePath: text("readme_path"),
    readmeRef: text("readme_ref"),
    readmeSha256: text("readme_sha256"),
    // What the version's README is. A failed refresh does not change it; the
    // attempts and error below say the refresh is failing.
    readmeStatus: text("readme_status")
      .$type<McpServerReadmeStatus>()
      .notNull()
      .default("pending"),
    readmeEtag: text("readme_etag"),
    readmeFetchedAt: timestamp("readme_fetched_at", {
      withTimezone: true,
      mode: "date",
    }),
    // When the fetch job should read the README again. A new version is due at
    // once; null means the job gave up until a market admin asks again.
    readmeNextFetchAt: timestamp("readme_next_fetch_at", {
      withTimezone: true,
      mode: "date",
    }).defaultNow(),
    readmeAttempts: integer("readme_attempts").notNull().default(0),
    readmeError: text("readme_error"),
    provenanceJson: jsonb("provenance_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("mcp_server_versions_server_version_uq").on(
      table.serverId,
      table.version,
    ),
    index("mcp_server_versions_server_status_idx").on(
      table.serverId,
      table.status,
    ),
    // The README fetch scheduler's scan for versions that are due.
    index("mcp_server_versions_readme_due_idx").on(table.readmeNextFetchAt),
    check(
      "mcp_server_versions_status_check",
      sql`${table.status} in ('draft', 'reviewing', 'published', 'unlisted', 'archived')`,
    ),
    check(
      "mcp_server_versions_origin_check",
      sql`${table.origin} in ('upstream', 'submitted')`,
    ),
    check(
      "mcp_server_versions_readme_status_check",
      sql`${table.readmeStatus} in ('pending', 'ok', 'not_found', 'too_large', 'unsupported_host', 'error')`,
    ),
  ],
);

export const mcpCategories = pgTable("mcp_categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const mcpServerCategories = pgTable(
  "mcp_server_categories",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => mcpCategories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      columns: [table.serverId, table.categoryId],
      name: "mcp_server_categories_pk",
    }),
  ],
);

// ---------------------------------------------------------------------------
// AI overviews of MCP servers, built from the catalog overview column
// definitions shared with skills (`catalog-overview.ts`) and written by the
// backend's catalog overview engine. One row per (version, locale); the
// author's own description stays on `mcp_servers` and is never overwritten.
// ---------------------------------------------------------------------------

/**
 * One MCP server version's classification: one to three categories, main
 * purpose first, each with a quotation from the input the model was shown.
 */
export type McpAnalysisClassification = CatalogClassificationOutcome & {
  categories: Array<{ slug: string; evidence: string }>;
  rationale: string;
};

export const mcpServerVersionOverviews = pgTable(
  "mcp_server_version_overviews",
  {
    mcpServerVersionId: text("mcp_server_version_id")
      .notNull()
      .references(() => mcpServerVersions.id, { onDelete: "cascade" }),
    // The input fingerprint (`buildMcpOverviewInput`'s `inputSha256`).
    ...catalogOverviewColumns({ key: "inputSha256", name: "input_sha256" }),
  },
  (table) =>
    catalogOverviewConstraints("mcp_server_version_overviews", {
      versionId: table.mcpServerVersionId,
      locale: table.locale,
    }),
);

// Durable generation state and the language-independent classification. Old
// output stays live while a newer request runs; `request_id` fences stale
// workers.
export const mcpServerVersionAnalysis = pgTable(
  "mcp_server_version_analysis",
  {
    mcpServerVersionId: text("mcp_server_version_id")
      .primaryKey()
      .references(() => mcpServerVersions.id, { onDelete: "cascade" }),
    ...catalogAnalysisColumns<McpAnalysisClassification>(),
  },
  (table) => catalogAnalysisConstraints("mcp_server_version_analysis", table),
);

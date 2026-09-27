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
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
    readmeMd: text("readme_md"),
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
    check(
      "mcp_server_versions_status_check",
      sql`${table.status} in ('draft', 'reviewing', 'published', 'unlisted', 'archived')`,
    ),
    check(
      "mcp_server_versions_origin_check",
      sql`${table.origin} in ('upstream', 'submitted')`,
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

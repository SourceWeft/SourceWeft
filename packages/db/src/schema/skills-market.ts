import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";

type SkillDefinitionSourceType =
  | "builtin"
  | "workspace_custom"
  | "team_custom"
  // Submission-based GitHub registry index (docs/architecture/
  // skill-registry-index.md): indexed from a submitted repo, pinned to an
  // immutable commit recorded in `storagePointer`.
  | "registry_github";
type SkillDefinitionStatus = "active" | "archived";
type SkillVersionStatus = "draft" | "published" | "deprecated" | "disabled";
type SkillVersionStorageType = "repo_builtin" | "db_text";
export type SkillManifestVisibility =
  "public" | "restricted" | "workspace" | "team";
export type SkillManifestJson = {
  slug: string;
  displayName: string;
  version: string;
  description: string;
  visibility: SkillManifestVisibility;
  // Selection behavior is explicit and independent from catalog visibility.
  defaultEnabled?: boolean;
  // Market surfacing, orthogonal to `visibility`. `listing: "hidden"` keeps the
  // skill out of the market entirely; `managed: true` makes it installable/
  // uninstallable per workspace (default false = always-on built-in capability).
  listing?: "listed" | "hidden";
  managed?: boolean;
  categories: string[];
  capabilities?: {
    required?: string[];
    optional?: string[];
  };
  models?: {
    chat?: string;
    image?: string;
    vision?: string;
  };
  commands?: {
    id: string;
    name: string;
    canonicalName: string;
    displayName: string;
    description: string;
    path: string;
    argumentHint?: string;
    title?: string;
    skillSlugs?: string[];
    tools?: string[];
    model?: string;
    slash?: boolean;
  }[];
  tools?: string[];
  options?: {
    id: string;
    title: string;
    description?: string;
    valueType: "string" | "number" | "boolean";
    defaultValue?: string | number | boolean;
    target: {
      toolName?: string;
      path: string;
    };
    /**
     * Pointer to the model-catalog annotation that narrows this option's
     * values for the selected model. Opaque here — it is capability vocabulary
     * that the manifest carries through to the client unread.
     */
    modelValues?: {
      key: string;
      path: string;
    };
    values: {
      value: string | number | boolean;
      label?: string;
    }[];
  }[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
  /**
   * Registry-sourced skill fields (sourceType='registry_github' only;
   * docs/architecture/skill-registry-index.md §2). All metadata — never
   * content bodies. `fileManifest` is what lets the runtime fetch individual
   * files by path at the pinned commit instead of extracting an archive.
   */
  registry?: {
    /** Real upstream identifier, e.g. "gh:owner/repo". */
    identifier: string;
    sourceUrl: string;
    repoUrl: string;
    submittedBy: string;
    /** Decides sandbox material sync, not permission (§6b). */
    capability: "prompt-only" | "executable";
    scan: { reviewRequired: boolean; flags: string[] };
    ingestion?: {
      formatVersion: 1; analyzedAt: string; parserVersion: string; scanRuleVersion: string;
      diagnostics: Array<{ code: string; severity: "error" | "warning"; message: string; file?: string; field?: string; line?: number; column?: number }>;
      findings: Array<{ ruleId: string; file?: string; line?: number }>;
    };
    moderation?: { action: "publish" | "reject" | "revoke"; actorUserId: string; at: string; reason?: string };
    visibilityChange?: { actorUserId: string; at: string; visibility: "public" | "restricted" };
    /** Declared license name (e.g. "MIT") — display-only. */
    license?: string;
    fileManifest: {
      path: string;
      sha256: string;
      sizeBytes: number;
      role: "model-readable" | "script";
    }[];
  };
};

export const skillDefinitions = pgTable(
  "skill_definitions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    sourceType: text("source_type")
      .$type<SkillDefinitionSourceType>()
      .notNull(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    visibility: text("visibility").$type<SkillManifestVisibility>().notNull(),
    status: text("status")
      .$type<SkillDefinitionStatus>()
      .notNull()
      .default("active"),
    ownerUserId: text("owner_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "skill_definitions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "skill_definitions_source_type_check",
      sql`${table.sourceType} in ('builtin', 'workspace_custom', 'team_custom', 'registry_github')`,
    ),
    check(
      "skill_definitions_visibility_check",
      sql`${table.visibility} in ('public', 'restricted', 'workspace', 'team')`,
    ),
    check(
      "skill_definitions_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "skill_definitions_scope_check",
      sql`(${table.sourceType} = 'builtin' and ${table.teamId} is null and ${table.workspaceId} is null and ${table.visibility} in ('public', 'restricted')) or (${table.sourceType} = 'workspace_custom' and ${table.teamId} is not null and ${table.workspaceId} is not null and ${table.visibility} = 'workspace') or (${table.sourceType} = 'team_custom' and ${table.teamId} is not null and ${table.workspaceId} is null and ${table.visibility} = 'team') or (${table.sourceType} = 'registry_github' and ${table.teamId} is null and ${table.workspaceId} is null and ${table.visibility} in ('public', 'restricted'))`,
    ),
    uniqueIndex("skill_definitions_slug_uq").on(table.slug),
    index("skill_definitions_team_workspace_status_idx").on(
      table.teamId,
      table.workspaceId,
      table.status,
    ),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status")
      .$type<SkillVersionStatus>()
      .notNull()
      .default("draft"),
    storageType: text("storage_type")
      .$type<SkillVersionStorageType>()
      .notNull(),
    storagePointer: text("storage_pointer").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    contentHash: text("content_hash").notNull(),
    manifestJson: jsonb("manifest_json").$type<SkillManifestJson>().notNull(),
    createdBy: text("created_by"),
    publishedAt: timestamp("published_at", {
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
    check(
      "skill_versions_status_check",
      sql`${table.status} in ('draft', 'published', 'deprecated', 'disabled')`,
    ),
    check(
      "skill_versions_storage_type_check",
      sql`${table.storageType} in ('repo_builtin', 'db_text')`,
    ),
    uniqueIndex("skill_versions_skill_version_uq").on(
      table.skillId,
      table.version,
    ),
    uniqueIndex("skill_versions_id_skill_uq").on(table.id, table.skillId),
    uniqueIndex("skill_versions_skill_current_uq")
      .on(table.skillId)
      .where(sql`${table.isCurrent} = true`),
    index("skill_versions_skill_status_idx").on(table.skillId, table.status),
  ],
);

export const skillVersionFiles = pgTable(
  "skill_version_files",
  {
    id: text("id").primaryKey(),
    skillVersionId: text("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentText: text("content_text").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_version_files_version_path_uq").on(
      table.skillVersionId,
      table.path,
    ),
    check("skill_version_files_size_check", sql`${table.sizeBytes} >= 0`),
    check(
      "skill_version_files_relative_path_check",
      sql`${table.path} <> '' and ${table.path} not like '/%' and ${table.path} not like '../%' and ${table.path} not like '%/../%'`,
    ),
  ],
);

export const workspaceSkills = pgTable(
  "workspace_skills",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    skillVersionId: text("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    enabledBy: text("enabled_by"),
    enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "workspace_skills_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "workspace_skills_skill_version_skill_fk",
      columns: [table.skillVersionId, table.skillId],
      foreignColumns: [skillVersions.id, skillVersions.skillId],
    }).onDelete("cascade"),
    uniqueIndex("workspace_skills_skill_uq").on(
      table.workspaceId,
      table.skillId,
    ),
    index("workspace_skills_workspace_enabled_idx").on(
      table.teamId,
      table.workspaceId,
      table.enabled,
    ),
  ],
);

export const skillEntitlements = pgTable(
  "skill_entitlements",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    teamId: text("team_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    grantedBy: text("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "skill_entitlements_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "skill_entitlements_scope_check",
      sql`${table.teamId} is not null or ${table.workspaceId} is not null`,
    ),
    index("skill_entitlements_skill_idx").on(
      table.skillId,
      table.teamId,
      table.workspaceId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Market (publisher side) — the MCP/skill catalog. Migrated from the retired
// sourceweft-api service so the catalog lives in the main app database. We are a
// downstream discovery catalog: rows point to public GitHub repos, sourced by
// federating upstream registries (origin=upstream) or direct submission
// (origin=submitted). No per-manifest signing (registry is the trust anchor).
// ---------------------------------------------------------------------------

type MarketItemKind = "skill" | "mcp";
type MarketItemStatus =
  "draft" | "reviewing" | "published" | "unlisted" | "archived";
type MarketItemVisibility = "public" | "private" | "internal";
type MarketItemVersionOrigin = "upstream" | "submitted";

export const marketItems = pgTable(
  "market_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<MarketItemKind>().notNull(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").$type<MarketItemStatus>().notNull(),
    visibility: text("visibility").$type<MarketItemVisibility>().notNull(),
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
    uniqueIndex("market_items_identifier_uq").on(table.identifier),
    index("market_items_kind_status_visibility_idx").on(
      table.kind,
      table.status,
      table.visibility,
    ),
    // Serves the default catalog browse + keyset pagination: filter by
    // kind/status/visibility, order by publishedAt desc then id desc.
    index("market_items_browse_idx").on(
      table.kind,
      table.status,
      table.visibility,
      desc(table.publishedAt),
      desc(table.id),
    ),
    check("market_items_kind_check", sql`${table.kind} in ('skill', 'mcp')`),
    check(
      "market_items_status_check",
      sql`${table.status} in ('draft', 'reviewing', 'published', 'unlisted', 'archived')`,
    ),
    check(
      "market_items_visibility_check",
      sql`${table.visibility} in ('public', 'private', 'internal')`,
    ),
  ],
);

export const marketItemVersions = pgTable(
  "market_item_versions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => marketItems.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status").$type<MarketItemStatus>().notNull(),
    // How this version entered the catalog, and which upstream/source produced
    // it (e.g. "registry.modelcontextprotocol.io", "github", "submission").
    origin: text("origin")
      .$type<MarketItemVersionOrigin>()
      .notNull()
      .default("submitted"),
    source: text("source"),
    manifestJson: jsonb("manifest_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    readmeMd: text("readme_md"),
    packageObjectKey: text("package_object_key"),
    packageSha256: text("package_sha256"),
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
    uniqueIndex("market_item_versions_item_version_uq").on(
      table.itemId,
      table.version,
    ),
    index("market_item_versions_item_status_idx").on(
      table.itemId,
      table.status,
    ),
    check(
      "market_item_versions_status_check",
      sql`${table.status} in ('draft', 'reviewing', 'published', 'unlisted', 'archived')`,
    ),
    check(
      "market_item_versions_origin_check",
      sql`${table.origin} in ('upstream', 'submitted')`,
    ),
  ],
);

export const marketCategories = pgTable("market_categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const marketItemCategories = pgTable(
  "market_item_categories",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => marketItems.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => marketCategories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.categoryId],
      name: "market_item_categories_pk",
    }),
  ],
);

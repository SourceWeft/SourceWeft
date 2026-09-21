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
type SkillVersionStorageType = "repo_builtin" | "db_text" | "object";
export type SkillManifestVisibility =
  "public" | "restricted" | "workspace" | "team";
export type SkillManifestJson = {
  /** Display-only thumbnail or declared image; never mounted as skill instructions. */
  logo?: { url: string; source: "skill" | "publisher"; path?: string };
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
   * Safety scan of a workspace-authored (custom) skill, taken at publish with
   * the same rules community skills are scanned with. Recorded, never a gate:
   * the author is a member, so flags do not block or queue their own skill.
   * Absent on versions published before the scan existed.
   */
  customScan?: {
    capability: "prompt-only" | "executable";
    flags: string[];
    findings: Array<{ ruleId: string; file?: string; line?: number }>;
    scanRuleVersion: string;
    scannedAt: string;
  };
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
    /**
     * Committer date (ISO 8601) of the pinned commit. Decides which published
     * version is current — by commit age, not by which write landed last.
     * Absent on versions indexed before this was captured, and when GitHub's
     * commit metadata could not be read; such a version ranks as oldest.
     */
    committedAt?: string;
    /**
     * Where the pinned commit was confirmed to come from: the repository's
     * default branch, whose history held it when it was checked. A commit that
     * exists only in a fork is served under the upstream's URLs too, so this
     * is what makes the upstream's name on the entry true. Absent on versions
     * indexed before the check existed; the market checks those itself.
     */
    provenance?: { defaultBranch: string; checkedAt: string };
    /** Decides sandbox material sync, not permission (§6b). */
    capability: "prompt-only" | "executable";
    scan: { reviewRequired: boolean; flags: string[] };
    ingestion?: {
      formatVersion: 1; analyzedAt: string; parserVersion: string; scanRuleVersion: string;
      diagnostics: Array<{ code: string; severity: "error" | "warning"; message: string; file?: string; field?: string; line?: number; column?: number }>;
      findings: Array<{ ruleId: string; file?: string; line?: number }>;
    };
    moderation?: {
      action: "publish" | "reject" | "revoke";
      actorUserId: string;
      at: string;
      reason?: string;
      /** Revoking the current version: the published version that took over. */
      promotedSkillVersionId?: string;
    };
    visibilityChange?: { actorUserId: string; at: string; visibility: "public" | "restricted" };
    /** Declared license name (e.g. "MIT") — display-only. */
    license?: string;
    fileManifest: {
      path: string;
      sha256: string;
      sizeBytes: number;
      // `asset`: a non-text resource (font, image, template) — carried for
      // scripts to use in the sandbox, never read by the model as text.
      role: "model-readable" | "script" | "asset";
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
    // Marketplace columns, owned by `modules/skills/market` — nothing in the
    // ingest path writes them.
    //
    // When the skill first became public. Set once and never moved, so it is a
    // stable keyset key for "newest": re-listing or a new version must not
    // reshuffle pages someone is scrolling through.
    listedAt: timestamp("listed_at", { withTimezone: true, mode: "date" }),
    // Granted by a market admin only; never read from a manifest.
    verified: boolean("verified").notNull().default(false),
    // Refreshed by the scheduler from `workspace_skills`, so sorting by
    // popularity does not put a write on the install path.
    installCount: integer("install_count").notNull().default(0),
    // An admin took this off the public market. The auto-listing pass skips it,
    // so a withdrawn skill does not come back on the next tick.
    listingHold: boolean("listing_hold").notNull().default(false),
    // Who holds it. The person who imported a skill can keep it off the public
    // market themselves; an admin's hold outranks theirs, so an owner can never
    // put back what an admin withdrew.
    listingHoldBy: text("listing_hold_by").$type<"admin" | "owner">(),
    // The GitHub repository a community skill comes from, lowercased. Kept on
    // the definition so a repository's skills can be found together — for a
    // claim, for "more from this repository", for its GitHub metadata.
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    // When the repository's author claimed it (`skill_repo_claims`); null for
    // a skill nobody has claimed.
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    // Copied from `skill_repositories` by the scheduler so sorting needs no join.
    repoStars: integer("repo_stars").notNull().default(0),
    // What "recommended" sorts by after `verified`: installs and GitHub stars
    // folded into one number by the scheduler (`market/rank.ts`), so the order
    // is keyset-pageable on a real column.
    rankScore: integer("rank_score").notNull().default(0),
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
    index("skill_definitions_market_new_idx").on(
      table.visibility,
      table.status,
      desc(table.listedAt),
      desc(table.id),
    ),
    index("skill_definitions_market_popular_idx").on(
      table.visibility,
      table.status,
      desc(table.installCount),
      desc(table.id),
    ),
    index("skill_definitions_market_rank_idx").on(
      table.visibility,
      table.status,
      desc(table.verified),
      desc(table.rankScore),
      desc(table.id),
    ),
    index("skill_definitions_repo_idx").on(table.repoOwner, table.repoName),
    check(
      "skill_definitions_listing_hold_by_check",
      sql`(${table.listingHold} = false and ${table.listingHoldBy} is null) or (${table.listingHold} = true and ${table.listingHoldBy} in ('admin', 'owner'))`,
    ),
    check(
      "skill_definitions_install_count_check",
      sql`${table.installCount} >= 0`,
    ),
  ],
);

// The skill market's own taxonomy. Deliberately not `market_categories`: that
// table is the MCP catalog's, and sharing it would put a `kind` filter on every
// MCP category query for no gain.
export const skillCategories = pgTable(
  "skill_categories",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [uniqueIndex("skill_categories_slug_uq").on(table.slug)],
);

// GitHub's facts about a repository community skills come from, refreshed by
// the scheduler with conditional requests. One row per repository, however many
// skills it ships.
export const skillRepositories = pgTable(
  "skill_repositories",
  {
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    githubId: text("github_id"),
    ownerGithubId: text("owner_github_id"),
    ownerType: text("owner_type").$type<"User" | "Organization">(),
    defaultBranch: text("default_branch"),
    stars: integer("stars").notNull().default(0),
    forks: integer("forks").notNull().default(0),
    pushedAt: timestamp("pushed_at", { withTimezone: true, mode: "date" }),
    archived: boolean("archived").notNull().default(false),
    etag: text("etag"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({
      name: "skill_repositories_pk",
      columns: [table.repoOwner, table.repoName],
    }),
    index("skill_repositories_fetched_idx").on(table.fetchedAt),
  ],
);

// A repository's author claiming its skills: started by them, proven by their
// linked GitHub account or a token file they commit, never assigned for them.
export const skillRepoClaims = pgTable(
  "skill_repo_claims",
  {
    id: text("id").primaryKey(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    userId: text("user_id").notNull(),
    method: text("method")
      .$type<"github_account" | "verification_file">()
      .notNull(),
    // sha256 of the token a verification file must contain; null for the
    // account method.
    tokenHash: text("token_hash"),
    status: text("status")
      .$type<"pending" | "verified" | "revoked">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    check(
      "skill_repo_claims_method_check",
      sql`${table.method} in ('github_account', 'verification_file')`,
    ),
    check(
      "skill_repo_claims_status_check",
      sql`${table.status} in ('pending', 'verified', 'revoked')`,
    ),
    // One author per repository at a time.
    uniqueIndex("skill_repo_claims_verified_uq")
      .on(table.repoOwner, table.repoName)
      .where(sql`${table.status} = 'verified'`),
    index("skill_repo_claims_user_idx").on(table.userId),
  ],
);

// Editorial collections on the public market: a titled, ordered set of skills.
export const skillCollections = pgTable(
  "skill_collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    position: integer("position").notNull().default(0),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("skill_collections_slug_uq").on(table.slug)],
);

export const skillCollectionItems = pgTable(
  "skill_collection_items",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => skillCollections.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "skill_collection_items_pk",
      columns: [table.collectionId, table.skillId],
    }),
  ],
);

export const skillDefinitionCategories = pgTable(
  "skill_definition_categories",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skillDefinitions.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => skillCategories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      name: "skill_definition_categories_pk",
      columns: [table.skillId, table.categoryId],
    }),
    index("skill_definition_categories_category_idx").on(table.categoryId),
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
    // `object` versions keep only SKILL.md in the database — it is what the
    // catalog shows and what a turn loads up front. Every file, SKILL.md
    // included, lives in object storage as a content-addressed blob, and the
    // whole skill as one deterministic zip the sandbox downloads.
    skillMd: text("skill_md"),
    bundleSha256: text("bundle_sha256"),
    bundleObjectKey: text("bundle_object_key"),
    bundleSizeBytes: integer("bundle_size_bytes"),
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
      sql`${table.storageType} in ('repo_builtin', 'db_text', 'object')`,
    ),
    check(
      "skill_versions_object_bundle_check",
      sql`${table.storageType} <> 'object' or (${table.skillMd} is not null and ${table.bundleSha256} is not null and ${table.bundleObjectKey} is not null and ${table.bundleSizeBytes} is not null)`,
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
    // Inline text (`db_text` versions: workspace-authored skills) OR a blob in
    // object storage (`object` versions) — never neither. A row is the file's
    // manifest entry either way: path, type, size and sha256 stay queryable
    // without touching the bytes.
    contentText: text("content_text"),
    objectKey: text("object_key"),
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
      "skill_version_files_content_location_check",
      sql`(${table.contentText} is not null) <> (${table.objectKey} is not null)`,
    ),
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
    // Who performed the install: a person in the catalog UI, or the chat agent
    // on its own initiative (`install_skill`). The agent acts AS the user, so
    // `enabledBy` cannot tell them apart — and "what did the agent add here?"
    // is the question someone reviewing a workspace's skills needs answered.
    installedVia: text("installed_via")
      .$type<"user" | "agent">()
      .notNull()
      .default("user"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "workspace_skills_installed_via_check",
      sql`${table.installedVia} in ('user', 'agent')`,
    ),
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
// Skill registry submissions — one row per asynchronous ingest of a community
// skill source. The catalog rows themselves (`skill_definitions` /
// `skill_versions`) are only written by the pipeline's last stage; this row is
// the progress + outcome record a client polls while the worker runs.
// ---------------------------------------------------------------------------

export type SkillSubmissionSourceKind = "github" | "upload";
export type SkillSubmissionTarget = "workspace" | "team";
export type SkillSubmissionStatus =
  "queued" | "running" | "succeeded" | "failed";
export type SkillSubmissionStageState = {
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: { code: string; message: string };
};
/**
 * Keyed by stage name. jsonb does not keep key order, so execution order is
 * read from `startedAt` (the API returns the stages sorted that way).
 */
export type SkillSubmissionStages = Record<string, SkillSubmissionStageState>;
export type SkillSubmissionSkillResult = {
  sourcePath: string;
  name?: string;
  slug?: string;
  skillVersionId?: string;
  version?: string;
  status: "indexed" | "queued" | "failed";
  flags: string[];
  diagnostics: Array<{
    code: string;
    severity: "error" | "warning";
    message: string;
    file?: string;
    field?: string;
    line?: number;
    column?: number;
  }>;
  /** Outcome of the `on_complete.install` action for this skill, if any. */
  install?: {
    // `skipped`: held for review, so there is no published version to install.
    status: "installed" | "already_installed" | "skipped" | "failed";
    error?: { code: string; message: string };
  };
};
export type SkillSubmissionOnComplete = {
  install?: { skill?: string; installedVia?: "user" | "agent" };
};

export const skillRegistrySubmissions = pgTable(
  "skill_registry_submissions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    submittedBy: text("submitted_by").notNull(),
    sourceKind: text("source_kind")
      .$type<SkillSubmissionSourceKind>()
      .notNull(),
    // What the submitter typed, trimmed. The parsed parts below are what the
    // pipeline reads; this is what dedupe and the UI key off.
    sourceInput: text("source_input").notNull(),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    ref: text("ref"),
    subpath: text("subpath"),
    // Filled by the `resolve` stage: the immutable commit everything is pinned to.
    commitSha: text("commit_sha"),
    commitCommittedAt: timestamp("commit_committed_at", {
      withTimezone: true,
      mode: "date",
    }),
    target: text("target")
      .$type<SkillSubmissionTarget>()
      .notNull()
      .default("workspace"),
    status: text("status")
      .$type<SkillSubmissionStatus>()
      .notNull()
      .default("queued"),
    stage: text("stage"),
    stages: jsonb("stages")
      .$type<SkillSubmissionStages>()
      .notNull()
      .default(emptyJsonObject),
    results: jsonb("results")
      .$type<SkillSubmissionSkillResult[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    onComplete: jsonb("on_complete").$type<SkillSubmissionOnComplete>(),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "skill_registry_submissions_source_kind_check",
      sql`${table.sourceKind} in ('github', 'upload')`,
    ),
    check(
      "skill_registry_submissions_target_check",
      sql`${table.target} in ('workspace', 'team')`,
    ),
    check(
      "skill_registry_submissions_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
    index("skill_registry_submissions_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    // Dedupe: one in-flight ingest per person per source. Re-submitting while
    // it runs returns that record; once it finishes the slot is free again.
    uniqueIndex("skill_registry_submissions_inflight_uq")
      .on(
        table.submittedBy,
        table.sourceKind,
        sql`lower(${table.sourceInput})`,
      )
      .where(sql`${table.status} in ('queued', 'running')`),
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

import { desc, sql } from "drizzle-orm";
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";

type BlogPostStatus = "draft" | "published" | "archived";
type BlogAssetKind = "cover" | "og_image" | "content_image" | "file";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export const blogPosts = pgTable(
  "blog_posts",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id").notNull(),
    locale: text("locale").notNull(),
    slug: text("slug").notNull(),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    status: text("status").$type<BlogPostStatus>().notNull().default("draft"),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    contentHtml: text("content_html").notNull().default(""),
    contentText: text("content_text").notNull().default(""),
    readingTimeMinutes: integer("reading_time_minutes").notNull().default(1),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    canonicalUrl: text("canonical_url"),
    ogImageAssetId: text("og_image_asset_id"),
    coverAssetId: text("cover_asset_id"),
    authorName: text("author_name"),
    category: text("category"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    featured: boolean("featured").notNull().default(false),
    featuredStartsAt: timestamp("featured_starts_at", {
      withTimezone: true,
      mode: "date",
    }),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
    sourceLastEditedAt: timestamp("source_last_edited_at", {
      withTimezone: true,
      mode: "date",
    }),
    contentHash: text("content_hash"),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("blog_posts_article_locale_uq").on(
      table.articleId,
      table.locale,
    ),
    uniqueIndex("blog_posts_locale_slug_uq").on(table.locale, table.slug),
    index("blog_posts_public_locale_published_idx")
      .on(table.locale, desc(table.publishedAt))
      .where(
        sql`${table.syncEnabled} = true and ${table.status} = 'published'`,
      ),
    index("blog_posts_article_idx").on(table.articleId),
    check(
      "blog_posts_locale_check",
      sql`${table.locale} in ('en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'he', 'hi', 'th')`,
    ),
    check(
      "blog_posts_status_check",
      sql`${table.status} in ('draft', 'published', 'archived')`,
    ),
    check(
      "blog_posts_reading_time_check",
      sql`${table.readingTimeMinutes} >= 1`,
    ),
  ],
);

export const blogAssets = pgTable(
  "blog_assets",
  {
    id: text("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => blogPosts.id, { onDelete: "cascade" }),
    assetKind: text("asset_kind").$type<BlogAssetKind>().notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    publicUrl: text("public_url").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256").notNull(),
    sourceUrlHash: text("source_url_hash").notNull(),
    altText: text("alt_text"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("blog_assets_post_kind_hash_uq").on(
      table.postId,
      table.assetKind,
      table.sha256,
    ),
    index("blog_assets_post_idx").on(table.postId),
    check(
      "blog_assets_kind_check",
      sql`${table.assetKind} in ('cover', 'og_image', 'content_image', 'file')`,
    ),
    check(
      "blog_assets_size_check",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
  ],
);

export const jobsAudit = pgTable(
  "jobs_audit",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    jobType: text("job_type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    queueName: text("queue_name"),
    status: text("status").$type<JobStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    resultJson: jsonb("result_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorJson: jsonb("error_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "jobs_audit_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }),
    check(
      "jobs_audit_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check("jobs_audit_attempts_check", sql`${table.attempts} >= 0`),
    uniqueIndex("jobs_audit_team_idempotency_uq").on(
      table.teamId,
      table.idempotencyKey,
    ),
    index("jobs_audit_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      desc(table.createdAt),
    ),
    index("jobs_audit_team_status_created_idx").on(
      table.teamId,
      table.status,
      desc(table.createdAt),
    ),
  ],
);

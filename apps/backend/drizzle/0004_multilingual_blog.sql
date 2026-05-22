CREATE TABLE IF NOT EXISTS "blog_posts" (
  "id" text PRIMARY KEY NOT NULL,
  "article_id" text NOT NULL,
  "locale" text NOT NULL,
  "slug" text NOT NULL,
  "sync_enabled" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "title" text NOT NULL,
  "excerpt" text DEFAULT '' NOT NULL,
  "content_html" text DEFAULT '' NOT NULL,
  "content_text" text DEFAULT '' NOT NULL,
  "reading_time_minutes" integer DEFAULT 1 NOT NULL,
  "seo_title" text,
  "seo_description" text,
  "canonical_url" text,
  "og_image_asset_id" text,
  "cover_asset_id" text,
  "author_name" text,
  "category" text,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "featured" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "updated_at" timestamp with time zone,
  "source_last_edited_at" timestamp with time zone,
  "content_hash" text,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "blog_posts_locale_check" CHECK ("blog_posts"."locale" in ('en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'he', 'hi', 'th')),
  CONSTRAINT "blog_posts_status_check" CHECK ("blog_posts"."status" in ('draft', 'published', 'archived')),
  CONSTRAINT "blog_posts_reading_time_check" CHECK ("blog_posts"."reading_time_minutes" >= 1)
);

CREATE TABLE IF NOT EXISTS "blog_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "post_id" text NOT NULL,
  "asset_kind" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_key" text NOT NULL,
  "public_url" text NOT NULL,
  "content_type" text,
  "size_bytes" bigint,
  "sha256" text NOT NULL,
  "source_url_hash" text NOT NULL,
  "alt_text" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "blog_assets_kind_check" CHECK ("blog_assets"."asset_kind" in ('cover', 'og_image', 'content_image', 'file')),
  CONSTRAINT "blog_assets_size_check" CHECK ("blog_assets"."size_bytes" is null or "blog_assets"."size_bytes" >= 0)
);

DO $$ BEGIN
 ALTER TABLE "blog_assets" ADD CONSTRAINT "blog_assets_post_id_blog_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."blog_posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "blog_posts_article_locale_uq" ON "blog_posts" USING btree ("article_id","locale");
CREATE UNIQUE INDEX IF NOT EXISTS "blog_posts_locale_slug_uq" ON "blog_posts" USING btree ("locale","slug");
CREATE INDEX IF NOT EXISTS "blog_posts_public_locale_published_idx" ON "blog_posts" USING btree ("locale","published_at" DESC) WHERE "sync_enabled" = true and "status" = 'published';
CREATE INDEX IF NOT EXISTS "blog_posts_article_idx" ON "blog_posts" USING btree ("article_id");
CREATE UNIQUE INDEX IF NOT EXISTS "blog_assets_post_kind_hash_uq" ON "blog_assets" USING btree ("post_id","asset_kind","sha256");
CREATE INDEX IF NOT EXISTS "blog_assets_post_idx" ON "blog_assets" USING btree ("post_id");

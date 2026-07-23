CREATE TABLE "market_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "market_item_categories" (
	"item_id" text NOT NULL,
	"category_id" text NOT NULL,
	CONSTRAINT "market_item_categories_pk" PRIMARY KEY("item_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "market_item_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"origin" text DEFAULT 'submitted' NOT NULL,
	"source" text,
	"manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"readme_md" text,
	"package_object_key" text,
	"package_sha256" text,
	"provenance_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "market_item_versions_status_check" CHECK ("market_item_versions"."status" in ('draft', 'reviewing', 'published', 'unlisted', 'archived')),
	CONSTRAINT "market_item_versions_origin_check" CHECK ("market_item_versions"."origin" in ('upstream', 'submitted'))
);
--> statement-breakpoint
CREATE TABLE "market_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"owner" text,
	"source_url" text,
	"repo_url" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "market_items_kind_check" CHECK ("market_items"."kind" in ('skill', 'mcp')),
	CONSTRAINT "market_items_status_check" CHECK ("market_items"."status" in ('draft', 'reviewing', 'published', 'unlisted', 'archived')),
	CONSTRAINT "market_items_visibility_check" CHECK ("market_items"."visibility" in ('public', 'private', 'internal'))
);
--> statement-breakpoint
ALTER TABLE "market_item_categories" ADD CONSTRAINT "market_item_categories_item_id_market_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."market_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_item_categories" ADD CONSTRAINT "market_item_categories_category_id_market_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."market_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_item_versions" ADD CONSTRAINT "market_item_versions_item_id_market_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."market_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_item_versions_item_version_uq" ON "market_item_versions" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX "market_item_versions_item_status_idx" ON "market_item_versions" USING btree ("item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "market_items_identifier_uq" ON "market_items" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "market_items_kind_status_visibility_idx" ON "market_items" USING btree ("kind","status","visibility");
CREATE TABLE "skill_market_events" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text,
	"repo_owner" text,
	"repo_name" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_market_events_actor_kind_check" CHECK ("skill_market_events"."actor_kind" in ('admin', 'owner', 'user', 'system'))
);
--> statement-breakpoint
CREATE TABLE "skill_market_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"review_id" text,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"contact_email" text,
	"reporter_user_id" text,
	"ip_hash" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_reports_reason_check" CHECK ("skill_reports"."reason" in ('copyright', 'malicious', 'impersonation', 'spam', 'broken', 'other')),
	CONSTRAINT "skill_reports_status_check" CHECK ("skill_reports"."status" in ('open', 'actioned', 'dismissed')),
	CONSTRAINT "skill_reports_reporter_check" CHECK ("skill_reports"."reporter_user_id" is not null or "skill_reports"."contact_email" is not null)
);
--> statement-breakpoint
CREATE TABLE "skill_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"skill_version_id" text,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'visible' NOT NULL,
	"hidden_by" text,
	"hidden_at" timestamp with time zone,
	"author_reply" text,
	"author_reply_by" text,
	"author_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_reviews_rating_check" CHECK ("skill_reviews"."rating" between 1 and 5),
	CONSTRAINT "skill_reviews_status_check" CHECK ("skill_reviews"."status" in ('visible', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "skill_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version_id" text,
	"workspace_hash" text NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"error_class" text,
	"error_subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_run_events_error_class_check" CHECK ("skill_run_events"."error_class" is null or "skill_run_events"."error_class" in ('missing_dependency', 'timeout', 'permission', 'other'))
);
--> statement-breakpoint
CREATE TABLE "skill_run_stats" (
	"skill_id" text PRIMARY KEY NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"workspaces" integer DEFAULT 0 NOT NULL,
	"top_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_version_overviews" (
	"skill_version_id" text NOT NULL,
	"locale" text NOT NULL,
	"bundle_sha256" text NOT NULL,
	"overview" jsonb NOT NULL,
	"model" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_overviews_pk" PRIMARY KEY("skill_version_id","locale"),
	CONSTRAINT "skill_version_overviews_locale_check" CHECK ("skill_version_overviews"."locale" in ('en', 'zh-CN', 'zh-TW'))
);
--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "categories_set_by" text;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "rating_avg" double precision;--> statement-breakpoint
ALTER TABLE "skill_market_events" ADD CONSTRAINT "skill_market_events_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reports" ADD CONSTRAINT "skill_reports_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reports" ADD CONSTRAINT "skill_reports_review_id_skill_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."skill_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reviews" ADD CONSTRAINT "skill_reviews_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reviews" ADD CONSTRAINT "skill_reviews_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run_events" ADD CONSTRAINT "skill_run_events_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run_events" ADD CONSTRAINT "skill_run_events_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_run_stats" ADD CONSTRAINT "skill_run_stats_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_overviews" ADD CONSTRAINT "skill_version_overviews_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_market_events_skill_created_idx" ON "skill_market_events" USING btree ("skill_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "skill_market_events_created_idx" ON "skill_market_events" USING btree ("created_at" desc);--> statement-breakpoint
CREATE INDEX "skill_reports_status_created_idx" ON "skill_reports" USING btree ("status","created_at" desc);--> statement-breakpoint
CREATE INDEX "skill_reports_skill_idx" ON "skill_reports" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_reports_ip_created_idx" ON "skill_reports" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_reviews_skill_user_uq" ON "skill_reviews" USING btree ("skill_id","user_id");--> statement-breakpoint
CREATE INDEX "skill_reviews_skill_created_idx" ON "skill_reviews" USING btree ("skill_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "skill_run_events_skill_created_idx" ON "skill_run_events" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_run_events_created_idx" ON "skill_run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "skill_version_overviews_bundle_idx" ON "skill_version_overviews" USING btree ("bundle_sha256","locale");
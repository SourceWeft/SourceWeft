CREATE TABLE "skill_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_definition_categories" (
	"skill_id" text NOT NULL,
	"category_id" text NOT NULL,
	CONSTRAINT "skill_definition_categories_pk" PRIMARY KEY("skill_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "install_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "listing_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definition_categories" ADD CONSTRAINT "skill_definition_categories_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_definition_categories" ADD CONSTRAINT "skill_definition_categories_category_id_skill_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."skill_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_categories_slug_uq" ON "skill_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skill_definition_categories_category_idx" ON "skill_definition_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "skill_definitions_market_new_idx" ON "skill_definitions" USING btree ("visibility","status","listed_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "skill_definitions_market_popular_idx" ON "skill_definitions" USING btree ("visibility","status","install_count" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_install_count_check" CHECK ("skill_definitions"."install_count" >= 0);--> statement-breakpoint
-- Skills that are already public were listed before `listed_at` existed. Date
-- them by when their current version was published, so "newest" has an order
-- from the first request instead of a pile of NULLs.
UPDATE "skill_definitions" AS d
SET "listed_at" = COALESCE(
	(SELECT v."published_at" FROM "skill_versions" v WHERE v."skill_id" = d."id" AND v."is_current" = true LIMIT 1),
	d."created_at"
)
WHERE d."visibility" = 'public' AND d."source_type" <> 'builtin' AND d."listed_at" IS NULL;

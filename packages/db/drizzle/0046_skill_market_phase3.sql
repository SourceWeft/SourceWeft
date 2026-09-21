CREATE TABLE "skill_collection_items" (
	"collection_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "skill_collection_items_pk" PRIMARY KEY("collection_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_repo_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"token_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "skill_repo_claims_method_check" CHECK ("skill_repo_claims"."method" in ('github_account', 'verification_file')),
	CONSTRAINT "skill_repo_claims_status_check" CHECK ("skill_repo_claims"."status" in ('pending', 'verified', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "skill_repositories" (
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"github_id" text,
	"owner_github_id" text,
	"owner_type" text,
	"default_branch" text,
	"stars" integer DEFAULT 0 NOT NULL,
	"forks" integer DEFAULT 0 NOT NULL,
	"pushed_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"etag" text,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "skill_repositories_pk" PRIMARY KEY("repo_owner","repo_name")
);
--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "repo_owner" text;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "repo_name" text;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "repo_stars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "rank_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_collection_items" ADD CONSTRAINT "skill_collection_items_collection_id_skill_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."skill_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_collection_items" ADD CONSTRAINT "skill_collection_items_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_collections_slug_uq" ON "skill_collections" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_repo_claims_verified_uq" ON "skill_repo_claims" USING btree ("repo_owner","repo_name") WHERE "skill_repo_claims"."status" = 'verified';--> statement-breakpoint
CREATE INDEX "skill_repo_claims_user_idx" ON "skill_repo_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_repositories_fetched_idx" ON "skill_repositories" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "skill_definitions_market_rank_idx" ON "skill_definitions" USING btree ("visibility","status","verified" desc,"rank_score" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "skill_definitions_repo_idx" ON "skill_definitions" USING btree ("repo_owner","repo_name");--> statement-breakpoint
-- Which repository each community skill comes from, read off the storage
-- pointer (`github:<owner>/<repo>@<sha>#<subpath>`) of any of its versions —
-- they all share it. Lowercased: GitHub treats owner and repository names
-- case-insensitively.
UPDATE "skill_definitions" AS d
SET
	"repo_owner" = lower(substring(p."storage_pointer" from '^github:([^/@#]+)/')),
	"repo_name" = lower(substring(p."storage_pointer" from '^github:[^/@#]+/([^/@#]+)@'))
FROM (
	SELECT DISTINCT ON (v."skill_id") v."skill_id", v."storage_pointer"
	FROM "skill_versions" v
	WHERE v."storage_pointer" LIKE 'github:%'
	ORDER BY v."skill_id", v."is_current" DESC, v."created_at" DESC
) AS p
WHERE p."skill_id" = d."id" AND d."source_type" = 'registry_github' AND d."repo_owner" IS NULL;

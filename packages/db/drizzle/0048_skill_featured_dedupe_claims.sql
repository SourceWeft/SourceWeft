ALTER TABLE "skill_repo_claims" DROP CONSTRAINT "skill_repo_claims_method_check";--> statement-breakpoint
DROP INDEX "skill_definitions_market_rank_idx";--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "featured_set_by" text;--> statement-breakpoint
ALTER TABLE "skill_registry_submissions" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_definitions_market_rank_idx" ON "skill_definitions" USING btree ("visibility","status","featured" desc,"verified" desc,"rank_score" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "skill_repo_claims" ADD CONSTRAINT "skill_repo_claims_method_check" CHECK ("skill_repo_claims"."method" in ('github_account', 'verification_file', 'admin_grant'));
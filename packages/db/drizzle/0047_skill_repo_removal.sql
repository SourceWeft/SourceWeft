ALTER TABLE "skill_repo_claims" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_repo_claims" ADD COLUMN "removed_by" text;
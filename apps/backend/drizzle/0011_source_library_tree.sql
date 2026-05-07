ALTER TABLE "sources" ADD COLUMN "parent_source_id" text;--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT IF EXISTS "sources_source_type_check";--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_source_type_check" CHECK ("sources"."source_type" in ('manual_upload', 'file_upload', 'web_url', 'youtube', 'note', 'artifact', 'connector', 'directory'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_team_workspace_parent_idx" ON "sources" USING btree ("team_id","workspace_id","parent_source_id");

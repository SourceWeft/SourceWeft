ALTER TABLE "artifacts" ADD COLUMN "preview_storage_key" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "preview_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL;

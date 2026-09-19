ALTER TABLE "working_files" ADD COLUMN "payload_kind" text DEFAULT 'inline_text' NOT NULL;
--> statement-breakpoint
ALTER TABLE "working_files" ADD COLUMN "storage_bucket" text;
--> statement-breakpoint
ALTER TABLE "working_files" ADD COLUMN "storage_key" text;
--> statement-breakpoint
ALTER TABLE "working_files" ADD COLUMN "content_hash" text DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' NOT NULL;
--> statement-breakpoint
ALTER TABLE "working_files" ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_payload_check" CHECK (("working_files"."payload_kind" = 'inline_text' and "working_files"."storage_bucket" is null and "working_files"."storage_key" is null) or ("working_files"."payload_kind" = 'object' and "working_files"."storage_bucket" is not null and "working_files"."storage_key" is not null and "working_files"."content_text" = ''));
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_hash_check" CHECK ("working_files"."content_hash" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_origin_check" CHECK ("working_files"."origin" in ('user_provided', 'agent_created', 'external', 'unknown'));

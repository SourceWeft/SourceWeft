ALTER TABLE "skill_versions" DROP CONSTRAINT "skill_versions_storage_type_check";--> statement-breakpoint
ALTER TABLE "skill_version_files" ALTER COLUMN "content_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "skill_md" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "bundle_sha256" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "bundle_object_key" text;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "bundle_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_content_location_check" CHECK (("skill_version_files"."content_text" is not null) <> ("skill_version_files"."object_key" is not null));--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_object_bundle_check" CHECK ("skill_versions"."storage_type" <> 'object' or ("skill_versions"."skill_md" is not null and "skill_versions"."bundle_sha256" is not null and "skill_versions"."bundle_object_key" is not null and "skill_versions"."bundle_size_bytes" is not null));--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_storage_type_check" CHECK ("skill_versions"."storage_type" in ('repo_builtin', 'db_text', 'object'));
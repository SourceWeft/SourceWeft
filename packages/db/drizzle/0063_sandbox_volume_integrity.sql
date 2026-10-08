CREATE TABLE "sandbox_volume_commits" (
	"volume_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"attachment_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"manifest_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_volume_commits_volume_id_seq_pk" PRIMARY KEY("volume_id","seq")
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" DROP CONSTRAINT "sandbox_volume_attachments_status_check";--> statement-breakpoint
DROP INDEX "sandbox_volumes_thread_uq";--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD COLUMN "last_applied_seq" bigint;
--> statement-breakpoint
-- Existing actors have no durable provenance: only their initial restore base is known.
UPDATE "sandbox_volume_attachments" SET "last_applied_seq" = "base_seq";
--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ALTER COLUMN "last_applied_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "sandbox_volumes" ADD COLUMN "namespace" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_volume_commits" ADD CONSTRAINT "sandbox_volume_commits_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_attachments_one_active_uq" ON "sandbox_volume_attachments" USING btree ("volume_id") WHERE "sandbox_volume_attachments"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volumes_thread_uq" ON "sandbox_volumes" USING btree ("team_id","workspace_id","thread_id","namespace");--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD CONSTRAINT "sandbox_volume_attachments_status_check" CHECK ("sandbox_volume_attachments"."status" in ('active', 'superseded', 'rejected', 'quarantined'));
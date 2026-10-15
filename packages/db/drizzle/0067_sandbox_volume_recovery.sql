CREATE TABLE "sandbox_volume_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"volume_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"drain_id" text,
	"kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"previous_supervisor_nonce" text,
	"supervisor_nonce" text,
	"journal_digest" text,
	"confirmed_seq" bigint NOT NULL,
	"unresolved_operations" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_volume_recoveries_kind_check" CHECK ("sandbox_volume_recoveries"."kind" in ('supervisor','provider_absent'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_drains" ADD COLUMN "recovery_controller_nonce" text;--> statement-breakpoint
ALTER TABLE "sandbox_volume_recoveries" ADD CONSTRAINT "sandbox_volume_recoveries_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_recoveries" ADD CONSTRAINT "sandbox_volume_recoveries_attachment_id_sandbox_volume_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."sandbox_volume_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_recoveries" ADD CONSTRAINT "sandbox_volume_recoveries_drain_id_sandbox_volume_drains_id_fk" FOREIGN KEY ("drain_id") REFERENCES "public"."sandbox_volume_drains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_recoveries_controller_uq" ON "sandbox_volume_recoveries" USING btree ("attachment_id","supervisor_nonce") WHERE "sandbox_volume_recoveries"."kind" = 'supervisor';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_recoveries_predecessor_uq" ON "sandbox_volume_recoveries" USING btree ("attachment_id","previous_supervisor_nonce") WHERE "sandbox_volume_recoveries"."kind" = 'supervisor';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_recoveries_operation_uq" ON "sandbox_volume_recoveries" USING btree ("attachment_id","kind","operation_id");
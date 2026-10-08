CREATE TABLE "sandbox_volume_drains" (
	"id" text PRIMARY KEY NOT NULL,
	"volume_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"supervisor_nonce" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draining' NOT NULL,
	"stopped_at" timestamp with time zone,
	"confirmed_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "sandbox_volume_drains_status_check" CHECK ("sandbox_volume_drains"."status" in ('draining','retired'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_execution_permits" (
	"id" text PRIMARY KEY NOT NULL,
	"volume_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"writer_kind" text DEFAULT 'external' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "sandbox_volume_execution_permits_writer_kind_check" CHECK ("sandbox_volume_execution_permits"."writer_kind" in ('external','supervised')),
	CONSTRAINT "sandbox_volume_execution_permits_status_check" CHECK ("sandbox_volume_execution_permits"."status" in ('active','released'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" DROP CONSTRAINT "sandbox_volume_attachments_status_check";--> statement-breakpoint
DROP INDEX "sandbox_volume_attachments_one_active_uq";--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD COLUMN "supervisor_nonce" text;--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD COLUMN "drain_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_volume_drains" ADD CONSTRAINT "sandbox_volume_drains_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_drains" ADD CONSTRAINT "sandbox_volume_drains_attachment_id_sandbox_volume_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."sandbox_volume_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_execution_permits" ADD CONSTRAINT "sandbox_volume_execution_permits_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_execution_permits" ADD CONSTRAINT "sandbox_volume_execution_permits_attachment_id_sandbox_volume_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."sandbox_volume_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_drains_attachment_uq" ON "sandbox_volume_drains" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_execution_permits_one_active_uq" ON "sandbox_volume_execution_permits" USING btree ("volume_id") WHERE "sandbox_volume_execution_permits"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_execution_permits_operation_uq" ON "sandbox_volume_execution_permits" USING btree ("attachment_id","operation_id");--> statement-breakpoint
CREATE INDEX "sandbox_volume_execution_permits_active_idx" ON "sandbox_volume_execution_permits" USING btree ("attachment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volume_attachments_one_writer_uq" ON "sandbox_volume_attachments" USING btree ("volume_id") WHERE "sandbox_volume_attachments"."status" in ('active', 'draining', 'quarantined');--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD CONSTRAINT "sandbox_volume_attachments_status_check" CHECK ("sandbox_volume_attachments"."status" in ('active', 'superseded', 'rejected', 'quarantined', 'draining', 'retired'));
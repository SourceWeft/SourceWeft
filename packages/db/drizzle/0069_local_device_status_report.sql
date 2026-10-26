ALTER TABLE "local_devices" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "arch" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "shell" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "sandbox_state" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "sandbox_code" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "sandbox_reason" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "sandbox_remedy" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "status_reported_at" timestamp with time zone;
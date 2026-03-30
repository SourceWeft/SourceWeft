CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text,
	"event_type" text NOT NULL,
	"team_id" text,
	"external_subscription_id" text,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_webhook_events_status_check" CHECK ("billing_webhook_events"."status" in ('received', 'processed', 'ignored', 'failed')),
	CONSTRAINT "billing_webhook_events_provider_check" CHECK ("billing_webhook_events"."provider" in ('none', 'creem', 'stripe', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_key" text NOT NULL,
	"level" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"team_id" text,
	"trigger_count" integer DEFAULT 1 NOT NULL,
	"first_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_alerts_level_check" CHECK ("ops_alerts"."level" in ('warn', 'error', 'critical')),
	CONSTRAINT "ops_alerts_status_check" CHECK ("ops_alerts"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_uq" ON "billing_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_team_status_idx" ON "billing_webhook_events" USING btree ("team_id","status","received_at" desc);--> statement-breakpoint
CREATE INDEX "billing_webhook_events_status_received_idx" ON "billing_webhook_events" USING btree ("status","received_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_alert_key_uq" ON "ops_alerts" USING btree ("alert_key");--> statement-breakpoint
CREATE INDEX "ops_alerts_level_status_triggered_idx" ON "ops_alerts" USING btree ("level","status","last_triggered_at" desc);--> statement-breakpoint
CREATE INDEX "ops_alerts_source_triggered_idx" ON "ops_alerts" USING btree ("source","last_triggered_at" desc);
CREATE TABLE "connector_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"workspace_id" text,
	"connector_id" text,
	"connector_type" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"object_id" text,
	"object_type" text,
	"sync_run_id" text,
	"payload_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_webhook_events_status_check" CHECK ("connector_webhook_events"."status" in ('received', 'queued', 'processed', 'ignored', 'failed')),
	CONSTRAINT "connector_webhook_events_attempts_check" CHECK ("connector_webhook_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_sync_run_id_connector_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."connector_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_webhook_events_provider_event_uq" ON "connector_webhook_events" USING btree ("connector_type","provider_event_id");--> statement-breakpoint
CREATE INDEX "connector_webhook_events_workspace_created_idx" ON "connector_webhook_events" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_webhook_events_connector_created_idx" ON "connector_webhook_events" USING btree ("connector_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_webhook_events_status_received_idx" ON "connector_webhook_events" USING btree ("status","received_at" desc);
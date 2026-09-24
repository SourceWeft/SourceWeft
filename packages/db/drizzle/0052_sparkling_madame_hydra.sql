CREATE TABLE "connector_sync_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"scope_hash" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"committed_cursor_json" jsonb,
	"page_cursor_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sync_run_id" text,
	"retry_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_occurrences_attempts_check" CHECK ("schedule_occurrences"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"task_kind" text NOT NULL,
	"owner_kind" text DEFAULT 'workspace' NOT NULL,
	"owner_user_id" text,
	"connector_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer,
	"spec_version" integer DEFAULT 1 NOT NULL,
	"spec_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_due_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_schedules_kind_check" CHECK ("task_schedules"."task_kind" in ('connector_sync', 'agent_task')),
	CONSTRAINT "task_schedules_target_check" CHECK (("task_schedules"."task_kind" = 'connector_sync' and "task_schedules"."owner_kind" = 'workspace' and "task_schedules"."connector_id" is not null and "task_schedules"."interval_minutes" > 0) or ("task_schedules"."task_kind" = 'agent_task' and "task_schedules"."owner_kind" = 'user' and "task_schedules"."owner_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "connector_sync_state" ADD CONSTRAINT "connector_sync_state_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."task_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_sync_run_id_connector_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."connector_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_occurrences_slot_uq" ON "schedule_occurrences" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "schedule_occurrences_pending_idx" ON "schedule_occurrences" USING btree ("status","retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_schedules_connector_uq" ON "task_schedules" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "task_schedules_due_idx" ON "task_schedules" USING btree ("enabled","next_due_at");--> statement-breakpoint
INSERT INTO "task_schedules" (
  "id", "team_id", "workspace_id", "task_kind", "owner_kind",
  "connector_id", "enabled", "interval_minutes", "spec_version",
  "spec_json", "timezone", "next_due_at", "created_at", "updated_at"
)
SELECT
  c."id", c."team_id", c."workspace_id", 'connector_sync', 'workspace',
  c."id", c."periodic_indexing_enabled" AND c."status" = 'active',
  COALESCE(c."indexing_frequency_minutes", 360), 1,
  jsonb_build_object('kind', 'interval', 'minutes', COALESCE(c."indexing_frequency_minutes", 360)),
  'UTC',
  CASE
    WHEN c."periodic_indexing_enabled" AND c."status" = 'active'
    THEN COALESCE(c."next_scheduled_at", now() + COALESCE(c."indexing_frequency_minutes", 360) * interval '1 minute')
    ELSE NULL
  END,
  c."created_at", now()
FROM "source_connectors" c
ON CONFLICT ("connector_id") DO NOTHING;

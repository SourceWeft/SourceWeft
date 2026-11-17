CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"trial_run_at" timestamp with time zone,
	"notify_on_success" boolean DEFAULT true NOT NULL,
	"notify_email" boolean DEFAULT true NOT NULL,
	"result_target" text DEFAULT 'new_thread' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "agent_tasks_id_workspace_team_owner_uq" UNIQUE("id","workspace_id","team_id","owner_user_id"),
	CONSTRAINT "agent_tasks_status_check" CHECK ("agent_tasks"."status" in ('draft', 'active', 'paused', 'blocked', 'completed', 'archived')),
	CONSTRAINT "agent_tasks_status_reason_check" CHECK ("agent_tasks"."status_reason" is null or "agent_tasks"."status_reason" in ('user_paused', 'owner_left', 'repeated_failure', 'insufficient_credits', 'tools_unavailable', 'auth_expired')),
	CONSTRAINT "agent_tasks_result_target_check" CHECK ("agent_tasks"."result_target" in ('new_thread')),
	CONSTRAINT "agent_tasks_name_length_check" CHECK (char_length("agent_tasks"."name") between 1 and 80),
	CONSTRAINT "agent_tasks_prompt_length_check" CHECK (char_length("agent_tasks"."prompt") between 1 and 20000),
	CONSTRAINT "agent_tasks_request_object_check" CHECK (jsonb_typeof("agent_tasks"."request_json") = 'object'),
	CONSTRAINT "agent_tasks_consecutive_failures_check" CHECK ("agent_tasks"."consecutive_failures" >= 0),
	CONSTRAINT "agent_tasks_version_check" CHECK ("agent_tasks"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "task_schedules" DROP CONSTRAINT "task_schedules_target_check";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_origin_check";--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "schedule_occurrences" AS o SET "team_id" = s."team_id", "workspace_id" = s."workspace_id" FROM "task_schedules" AS s WHERE s."id" = o."schedule_id";--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "trigger_kind" text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "chat_run_id" text;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "task_version" integer;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "is_catch_up" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "agent_task_id" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_owner_name_uq" ON "agent_tasks" USING btree ("workspace_id","owner_user_id",lower("name")) WHERE "agent_tasks"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "agent_tasks_owner_status_idx" ON "agent_tasks" USING btree ("team_id","owner_user_id","status");--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_chat_run_id_chat_thread_runs_id_fk" FOREIGN KEY ("chat_run_id") REFERENCES "public"."chat_thread_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_agent_task_owner_fk" FOREIGN KEY ("agent_task_id","workspace_id","team_id","owner_user_id") REFERENCES "public"."agent_tasks"("id","workspace_id","team_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_schedules_agent_task_uq" ON "task_schedules" USING btree ("agent_task_id");--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_status_check" CHECK ("schedule_occurrences"."status" in ('pending', 'dispatching', 'queued', 'succeeded', 'failed', 'skipped', 'blocked', 'cancelled'));--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_trigger_kind_check" CHECK ("schedule_occurrences"."trigger_kind" in ('schedule', 'manual', 'api', 'event'));--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_skip_reason_check" CHECK ("schedule_occurrences"."skip_reason" is null or ("schedule_occurrences"."status" in ('skipped', 'blocked') and "schedule_occurrences"."skip_reason" in ('missed_platform_down', 'previous_run_active', 'user_concurrency_limit', 'user_daily_cap', 'insufficient_credits', 'owner_left', 'tools_unavailable', 'auth_expired', 'rate_limited')));--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_task_version_check" CHECK ("schedule_occurrences"."task_version" is null or "schedule_occurrences"."task_version" >= 1);--> statement-breakpoint
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_target_check" CHECK (("task_schedules"."task_kind" = 'connector_sync' and "task_schedules"."owner_kind" = 'workspace' and "task_schedules"."connector_id" is not null and "task_schedules"."agent_task_id" is null and "task_schedules"."interval_minutes" > 0) or ("task_schedules"."task_kind" = 'agent_task' and "task_schedules"."owner_kind" = 'user' and "task_schedules"."owner_user_id" is not null and "task_schedules"."connector_id" is null));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_check" CHECK ("threads"."origin" in ('user', 'subagent', 'scheduled'));
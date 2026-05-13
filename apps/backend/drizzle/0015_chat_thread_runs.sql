CREATE TABLE "chat_thread_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_message_id" text,
	"assistant_message_id" text,
	"idempotency_key" text NOT NULL,
	"mode" text NOT NULL,
	"job_id" text,
	"stream_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"event_offset" integer DEFAULT 0 NOT NULL,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_runs_status_check" CHECK ("chat_thread_runs"."status" in ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "chat_thread_runs_mode_check" CHECK ("chat_thread_runs"."mode" in ('send', 'refresh', 'edit')),
	CONSTRAINT "chat_thread_runs_event_offset_check" CHECK ("chat_thread_runs"."event_offset" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_idempotency_uq" ON "chat_thread_runs" USING btree ("team_id","workspace_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_thread_active_uq" ON "chat_thread_runs" USING btree ("team_id","workspace_id","thread_id") WHERE "status" in ('queued', 'running', 'cancel_requested');
--> statement-breakpoint
CREATE INDEX "chat_thread_runs_thread_status_created_idx" ON "chat_thread_runs" USING btree ("team_id","workspace_id","thread_id","status","created_at" desc);
--> statement-breakpoint
CREATE INDEX "chat_thread_runs_job_idx" ON "chat_thread_runs" USING btree ("job_id");

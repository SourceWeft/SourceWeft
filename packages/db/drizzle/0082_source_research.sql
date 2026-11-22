CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"topic" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text,
	"progress_json" jsonb DEFAULT '{"round":0,"searches":0,"pagesRead":0,"modelCalls":0}'::jsonb NOT NULL,
	"plan_json" jsonb,
	"ledger_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_markdown" text,
	"report_citations_json" jsonb,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_runs_status_check" CHECK ("research_runs"."status" in ('queued', 'running', 'ready', 'failed', 'cancelled')),
	CONSTRAINT "research_runs_phase_check" CHECK ("research_runs"."phase" is null or "research_runs"."phase" in ('planning', 'searching', 'reading', 'reporting')),
	CONSTRAINT "research_runs_error_code_check" CHECK ("research_runs"."error_code" is null or "research_runs"."error_code" in ('WEB_PROVIDER_UNAVAILABLE', 'NO_RESULTS', 'RESEARCH_QUALITY_TOO_LOW', 'INSUFFICIENT_CREDITS', 'MODEL_UNAVAILABLE', 'TIME_LIMIT', 'ACCESS_LOST'))
);
--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_runs_workspace_created_idx" ON "research_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "research_runs_user_status_idx" ON "research_runs" USING btree ("created_by_user_id","status");
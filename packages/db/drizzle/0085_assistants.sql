CREATE TABLE "assistant_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"router_batch_key" text NOT NULL,
	"action" text NOT NULL,
	"ticket_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_decisions_trigger_batch_uq" UNIQUE("trigger_id","router_batch_key"),
	CONSTRAINT "assistant_decisions_action_check" CHECK ("assistant_decisions"."action" in ('create_ticket', 'route_to_ticket', 'ignore'))
);
--> statement-breakpoint
CREATE TABLE "assistant_feed_items" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"kind" text NOT NULL,
	"author_user_id" text,
	"text" text NOT NULL,
	"trigger_id" text,
	"ticket_id" text,
	"reply_to_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_feed_items_kind_check" CHECK ("assistant_feed_items"."kind" in ('member_message', 'router_message', 'ticket_update')),
	CONSTRAINT "assistant_feed_items_text_length_check" CHECK (char_length("assistant_feed_items"."text") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "assistant_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"worker_thread_id" text NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"payer_user_id" text NOT NULL,
	"origin" text DEFAULT 'explicit' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"blocked_reason" text,
	"credit_cap" numeric NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_report_summary" text,
	"current_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "assistant_tickets_origin_check" CHECK ("assistant_tickets"."origin" in ('explicit', 'inferred')),
	CONSTRAINT "assistant_tickets_stage_check" CHECK ("assistant_tickets"."stage" in ('queued', 'working', 'waiting_person', 'idle', 'ended')),
	CONSTRAINT "assistant_tickets_outcome_check" CHECK ("assistant_tickets"."outcome" is null or "assistant_tickets"."outcome" in ('ready', 'dropped', 'failed', 'blocked', 'waiting')),
	CONSTRAINT "assistant_tickets_blocked_reason_check" CHECK ("assistant_tickets"."blocked_reason" is null or "assistant_tickets"."blocked_reason" in ('credit_cap', 'insufficient_credits', 'repeated_failure')),
	CONSTRAINT "assistant_tickets_credit_cap_check" CHECK ("assistant_tickets"."credit_cap" >= 0),
	CONSTRAINT "assistant_tickets_consecutive_failures_check" CHECK ("assistant_tickets"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assistant_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"payer_user_id" text,
	"author_user_id" text,
	"dedupe_key" text NOT NULL,
	"text" text NOT NULL,
	"ticket_id" text,
	"routed_ticket_id" text,
	"delivered_at" timestamp with time zone,
	"status" text DEFAULT 'pending_eval' NOT NULL,
	"eval_attempts" integer DEFAULT 0 NOT NULL,
	"router_batch_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_triggers_assistant_dedupe_uq" UNIQUE("assistant_id","dedupe_key"),
	CONSTRAINT "assistant_triggers_source_kind_check" CHECK ("assistant_triggers"."source_kind" in ('member_message', 'worker_report')),
	CONSTRAINT "assistant_triggers_status_check" CHECK ("assistant_triggers"."status" in ('pending_eval', 'in_eval', 'decided', 'unavailable')),
	CONSTRAINT "assistant_triggers_text_length_check" CHECK (char_length("assistant_triggers"."text") <= 4000),
	CONSTRAINT "assistant_triggers_eval_attempts_check" CHECK ("assistant_triggers"."eval_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"router_thread_id" text NOT NULL,
	"steward_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"current_router_run_id" text,
	"current_router_batch_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistants_workspace_uq" UNIQUE("workspace_id"),
	CONSTRAINT "assistants_status_check" CHECK ("assistants"."status" in ('active', 'paused')),
	CONSTRAINT "assistants_status_reason_check" CHECK ("assistants"."status_reason" is null or "assistants"."status_reason" in ('steward_left', 'by_admin')),
	CONSTRAINT "assistants_version_check" CHECK ("assistants"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_origin_check";--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD COLUMN "consumed_credits" numeric;--> statement-breakpoint
ALTER TABLE "assistant_decisions" ADD CONSTRAINT "assistant_decisions_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_decisions" ADD CONSTRAINT "assistant_decisions_assistant_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_decisions" ADD CONSTRAINT "assistant_decisions_trigger_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."assistant_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_feed_items" ADD CONSTRAINT "assistant_feed_items_reply_to_item_id_assistant_feed_items_id_fk" FOREIGN KEY ("reply_to_item_id") REFERENCES "public"."assistant_feed_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_feed_items" ADD CONSTRAINT "assistant_feed_items_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_feed_items" ADD CONSTRAINT "assistant_feed_items_assistant_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tickets" ADD CONSTRAINT "assistant_tickets_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tickets" ADD CONSTRAINT "assistant_tickets_assistant_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_triggers" ADD CONSTRAINT "assistant_triggers_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_triggers" ADD CONSTRAINT "assistant_triggers_assistant_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_feed_items_assistant_created_id_idx" ON "assistant_feed_items" USING btree ("assistant_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "assistant_tickets_assistant_stage_created_idx" ON "assistant_tickets" USING btree ("assistant_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "assistant_triggers_assistant_status_payer_created_idx" ON "assistant_triggers" USING btree ("assistant_id","status","payer_user_id","created_at");--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_consumed_credits_check" CHECK ("chat_thread_runs"."consumed_credits" is null or "chat_thread_runs"."consumed_credits" >= 0);--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_check" CHECK ("threads"."origin" in ('user', 'subagent', 'scheduled', 'assistant_router', 'assistant_ticket'));
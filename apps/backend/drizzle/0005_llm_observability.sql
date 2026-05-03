CREATE TABLE "llm_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"message_id" text,
	"session_id" text,
	"name" text NOT NULL,
	"feature" text,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"latency_ms" integer,
	"tags_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_traces_status_check" CHECK ("llm_traces"."status" in ('running', 'ok', 'error', 'cancelled')),
	CONSTRAINT "llm_traces_latency_check" CHECK ("llm_traces"."latency_ms" is null or "llm_traces"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "llm_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"message_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"latency_ms" integer,
	"input_json" jsonb,
	"output_json" jsonb,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_spans_kind_check" CHECK ("llm_spans"."kind" in ('agent', 'tool', 'retrieval', 'vector_search', 'bm25', 'rerank', 'embedding', 'generation', 'system', 'thinking', 'http')),
	CONSTRAINT "llm_spans_status_check" CHECK ("llm_spans"."status" in ('running', 'ok', 'error', 'cancelled')),
	CONSTRAINT "llm_spans_latency_check" CHECK ("llm_spans"."latency_ms" is null or "llm_spans"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "llm_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"message_id" text,
	"operation" text NOT NULL,
	"model_alias" text,
	"provider" text,
	"provider_model" text,
	"execution_mode" text,
	"key_source" text,
	"route_strategy" text,
	"route_decision_json" jsonb,
	"model_parameters_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"output_text" text,
	"finish_reason" text,
	"reasoning_text" text,
	"provider_fields_json" jsonb,
	"usage_json" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"provider_cost_usd" numeric(12, 6),
	"raw_capture_mode" text DEFAULT 'normalized' NOT NULL,
	"provider_request_json" jsonb,
	"provider_response_json" jsonb,
	"provider_request_headers_json" jsonb,
	"provider_response_headers_json" jsonb,
	"provider_status_code" integer,
	"provider_request_id" text,
	"raw_capture_error" text,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"latency_ms" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_generations_status_check" CHECK ("llm_generations"."status" in ('running', 'ok', 'error', 'cancelled')),
	CONSTRAINT "llm_generations_raw_capture_mode_check" CHECK ("llm_generations"."raw_capture_mode" in ('none', 'normalized', 'sdk_metadata', 'reconstructed', 'provider_wire')),
	CONSTRAINT "llm_generations_execution_mode_check" CHECK ("llm_generations"."execution_mode" is null or "llm_generations"."execution_mode" in ('GLOBAL', 'BYOK')),
	CONSTRAINT "llm_generations_latency_check" CHECK ("llm_generations"."latency_ms" is null or "llm_generations"."latency_ms" >= 0),
	CONSTRAINT "llm_generations_input_tokens_check" CHECK ("llm_generations"."input_tokens" is null or "llm_generations"."input_tokens" >= 0),
	CONSTRAINT "llm_generations_output_tokens_check" CHECK ("llm_generations"."output_tokens" is null or "llm_generations"."output_tokens" >= 0),
	CONSTRAINT "llm_generations_total_tokens_check" CHECK ("llm_generations"."total_tokens" is null or "llm_generations"."total_tokens" >= 0),
	CONSTRAINT "llm_generations_provider_status_check" CHECK ("llm_generations"."provider_status_code" is null or "llm_generations"."provider_status_code" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "llm_feedback_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text,
	"generation_id" text,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"value" double precision NOT NULL,
	"comment" text,
	"source" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_audit_access_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback_scores" ADD CONSTRAINT "llm_feedback_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback_scores" ADD CONSTRAINT "llm_feedback_scores_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_audit_access_logs" ADD CONSTRAINT "llm_audit_access_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_audit_access_logs" ADD CONSTRAINT "llm_audit_access_logs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_traces_trace_idx" ON "llm_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "llm_traces_team_workspace_started_idx" ON "llm_traces" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_team_started_idx" ON "llm_traces" USING btree ("team_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_thread_started_idx" ON "llm_traces" USING btree ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_message_idx" ON "llm_traces" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "llm_traces_status_started_idx" ON "llm_traces" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_spans_trace_span_uq" ON "llm_spans" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE INDEX "llm_spans_trace_idx" ON "llm_spans" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_parent_idx" ON "llm_spans" USING btree ("trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_team_workspace_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_kind_started_idx" ON "llm_spans" USING btree ("kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_generations_trace_span_uq" ON "llm_generations" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE INDEX "llm_generations_trace_idx" ON "llm_generations" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_parent_idx" ON "llm_generations" USING btree ("trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_team_workspace_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_operation_started_idx" ON "llm_generations" USING btree ("operation","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_provider_started_idx" ON "llm_generations" USING btree ("provider","provider_model","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_status_started_idx" ON "llm_generations" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_message_idx" ON "llm_generations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_trace_idx" ON "llm_feedback_scores" USING btree ("trace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_generation_idx" ON "llm_feedback_scores" USING btree ("generation_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_team_workspace_idx" ON "llm_feedback_scores" USING btree ("team_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_team_workspace_idx" ON "llm_audit_access_logs" USING btree ("team_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_actor_idx" ON "llm_audit_access_logs" USING btree ("team_id","actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_target_idx" ON "llm_audit_access_logs" USING btree ("target_type","target_id","created_at");

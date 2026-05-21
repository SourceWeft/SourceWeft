CREATE TABLE "artifact_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"source_id" text,
	"document_id" text,
	"chunk_id" text,
	"role" text DEFAULT 'input' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_sources_role_check" CHECK ("artifact_sources"."role" in ('input', 'evidence', 'output'))
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"parent_version_id" text,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_version_no_check" CHECK ("artifact_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"artifact_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"prompt_text" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_bucket" text,
	"storage_key" text,
	"error_code" text,
	"error_message" text,
	"created_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_artifact_type_check" CHECK ("artifacts"."artifact_type" in ('report', 'slides', 'mindmap', 'podcast', 'audio_overview', 'video_overview', 'flashcards', 'quiz', 'table', 'infographic', 'image')),
	CONSTRAINT "artifacts_status_check" CHECK ("artifacts"."status" in ('pending', 'running', 'ready', 'failed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"team_id" text PRIMARY KEY NOT NULL,
	"plan_family" text NOT NULL,
	"cycle_anchor_at" timestamp with time zone NOT NULL,
	"cycle_source" text DEFAULT 'free_account' NOT NULL,
	"cycle_start_at" timestamp with time zone NOT NULL,
	"cycle_end_at" timestamp with time zone NOT NULL,
	"pages_limit" integer NOT NULL,
	"pages_used" integer DEFAULT 0 NOT NULL,
	"monthly_pages_grant" integer DEFAULT 0 NOT NULL,
	"monthly_pages_balance" integer DEFAULT 0 NOT NULL,
	"add_on_pages_balance" integer DEFAULT 0 NOT NULL,
	"pages_consumed_this_cycle" integer DEFAULT 0 NOT NULL,
	"monthly_credits_grant" integer NOT NULL,
	"monthly_credits_balance" integer NOT NULL,
	"add_on_credits_balance" integer DEFAULT 0 NOT NULL,
	"credits_reserved" integer DEFAULT 0 NOT NULL,
	"credits_consumed_this_cycle" integer DEFAULT 0 NOT NULL,
	"seat_count" integer DEFAULT 1 NOT NULL,
	"spend_soft_cap_usd" numeric(12, 4),
	"spend_hard_cap_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_cycle_source_check" CHECK ("billing_accounts"."cycle_source" in ('free_account', 'provider_subscription', 'manual')),
	CONSTRAINT "billing_accounts_pages_limit_check" CHECK ("billing_accounts"."pages_limit" >= 0),
	CONSTRAINT "billing_accounts_pages_used_check" CHECK ("billing_accounts"."pages_used" >= 0),
	CONSTRAINT "billing_accounts_monthly_pages_grant_check" CHECK ("billing_accounts"."monthly_pages_grant" >= 0),
	CONSTRAINT "billing_accounts_monthly_pages_balance_check" CHECK ("billing_accounts"."monthly_pages_balance" >= 0),
	CONSTRAINT "billing_accounts_add_on_pages_balance_check" CHECK ("billing_accounts"."add_on_pages_balance" >= 0),
	CONSTRAINT "billing_accounts_pages_consumed_check" CHECK ("billing_accounts"."pages_consumed_this_cycle" >= 0),
	CONSTRAINT "billing_accounts_monthly_grant_check" CHECK ("billing_accounts"."monthly_credits_grant" >= 0),
	CONSTRAINT "billing_accounts_monthly_balance_check" CHECK ("billing_accounts"."monthly_credits_balance" >= 0),
	CONSTRAINT "billing_accounts_add_on_balance_check" CHECK ("billing_accounts"."add_on_credits_balance" >= 0),
	CONSTRAINT "billing_accounts_reserved_check" CHECK ("billing_accounts"."credits_reserved" >= 0),
	CONSTRAINT "billing_accounts_consumed_check" CHECK ("billing_accounts"."credits_consumed_this_cycle" >= 0),
	CONSTRAINT "billing_accounts_soft_cap_check" CHECK ("billing_accounts"."spend_soft_cap_usd" is null or "billing_accounts"."spend_soft_cap_usd" >= 0),
	CONSTRAINT "billing_accounts_hard_cap_check" CHECK ("billing_accounts"."spend_hard_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" >= 0),
	CONSTRAINT "billing_accounts_hard_gte_soft_check" CHECK ("billing_accounts"."spend_soft_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" is null or "billing_accounts"."spend_hard_cap_usd" >= "billing_accounts"."spend_soft_cap_usd"),
	CONSTRAINT "billing_accounts_seat_count_check" CHECK ("billing_accounts"."seat_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "billing_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_status" text DEFAULT 'unknown' NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text,
	"client_reference_key" text,
	"plan_family" text,
	"billing_interval" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_type" text,
	"unit_amount" integer,
	"granted_credits" integer DEFAULT 0 NOT NULL,
	"granted_pages" integer DEFAULT 0 NOT NULL,
	"external_checkout_id" text,
	"external_payment_id" text,
	"external_customer_id" text,
	"external_subscription_id" text,
	"external_product_id" text,
	"amount_total" integer,
	"currency" text,
	"success_url" text,
	"cancel_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"paid_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"fulfillment_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_orders_provider_check" CHECK ("billing_orders"."provider" in ('none', 'creem', 'stripe', 'manual')),
	CONSTRAINT "billing_orders_kind_check" CHECK ("billing_orders"."kind" in ('subscription', 'credit_topup', 'page_topup')),
	CONSTRAINT "billing_orders_status_check" CHECK ("billing_orders"."status" in ('pending', 'checkout_created', 'payment_confirmed', 'fulfilled', 'payment_failed', 'expired', 'fulfillment_failed')),
	CONSTRAINT "billing_orders_payment_status_check" CHECK ("billing_orders"."payment_status" in ('unknown', 'unpaid', 'paid', 'failed', 'expired')),
	CONSTRAINT "billing_orders_plan_family_check" CHECK ("billing_orders"."plan_family" is null or "billing_orders"."plan_family" in ('individual_free', 'individual_pro', 'team_standard', 'team_premium', 'enterprise_usage')),
	CONSTRAINT "billing_orders_billing_interval_check" CHECK ("billing_orders"."billing_interval" is null or "billing_orders"."billing_interval" in ('monthly', 'yearly', 'unknown')),
	CONSTRAINT "billing_orders_unit_type_check" CHECK ("billing_orders"."unit_type" is null or "billing_orders"."unit_type" in ('credit', 'page')),
	CONSTRAINT "billing_orders_quantity_check" CHECK ("billing_orders"."quantity" >= 1),
	CONSTRAINT "billing_orders_unit_amount_check" CHECK ("billing_orders"."unit_amount" is null or "billing_orders"."unit_amount" > 0),
	CONSTRAINT "billing_orders_granted_credits_check" CHECK ("billing_orders"."granted_credits" >= 0),
	CONSTRAINT "billing_orders_granted_pages_check" CHECK ("billing_orders"."granted_pages" >= 0),
	CONSTRAINT "billing_orders_amount_total_check" CHECK ("billing_orders"."amount_total" is null or "billing_orders"."amount_total" >= 0),
	CONSTRAINT "billing_orders_attempt_count_check" CHECK ("billing_orders"."fulfillment_attempt_count" >= 0),
	CONSTRAINT "billing_orders_subscription_shape_check" CHECK ("billing_orders"."kind" <> 'subscription' or ("billing_orders"."plan_family" in ('individual_pro', 'team_standard') and "billing_orders"."billing_interval" in ('monthly', 'yearly') and "billing_orders"."unit_type" is null and "billing_orders"."unit_amount" is null and "billing_orders"."granted_credits" = 0 and "billing_orders"."granted_pages" = 0)),
	CONSTRAINT "billing_orders_topup_shape_check" CHECK ("billing_orders"."kind" not in ('credit_topup', 'page_topup') or ("billing_orders"."team_id" is not null and "billing_orders"."unit_type" is not null and "billing_orders"."unit_amount" is not null and ("billing_orders"."granted_credits" > 0 or "billing_orders"."granted_pages" > 0))),
	CONSTRAINT "billing_orders_credit_topup_shape_check" CHECK ("billing_orders"."kind" <> 'credit_topup' or ("billing_orders"."unit_type" = 'credit' and "billing_orders"."granted_credits" = "billing_orders"."unit_amount" * "billing_orders"."quantity" and "billing_orders"."granted_pages" = 0)),
	CONSTRAINT "billing_orders_page_topup_shape_check" CHECK ("billing_orders"."kind" <> 'page_topup' or ("billing_orders"."unit_type" = 'page' and "billing_orders"."granted_pages" = "billing_orders"."unit_amount" * "billing_orders"."quantity" and "billing_orders"."granted_credits" = 0)),
	CONSTRAINT "billing_orders_pro_team_required_check" CHECK ("billing_orders"."plan_family" <> 'individual_pro' or "billing_orders"."team_id" is not null),
	CONSTRAINT "billing_orders_team_checkout_no_org_check" CHECK ("billing_orders"."plan_family" <> 'team_standard' or "billing_orders"."status" not in ('pending', 'checkout_created') or "billing_orders"."team_id" is null)
);
--> statement-breakpoint
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
CREATE TABLE "chunk_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"embedding_profile_id" text NOT NULL,
	"model_alias" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_embeddings_dim_check" CHECK ("chunk_embeddings"."dim" > 0 and "chunk_embeddings"."dim" <= 2000)
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"document_id" text NOT NULL,
	"chunk_no" integer NOT NULL,
	"content" text NOT NULL,
	"heading_path" text,
	"start_offset" integer,
	"end_offset" integer,
	"language" text,
	"search_parts" text[] DEFAULT '{}'::text[] NOT NULL,
	"chunk_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_chunk_no_check" CHECK ("chunks"."chunk_no" >= 0),
	CONSTRAINT "chunks_offsets_check" CHECK ("chunks"."start_offset" is null or "chunks"."end_offset" is null or "chunks"."start_offset" <= "chunks"."end_offset")
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source_id" text,
	"document_id" text,
	"chunk_id" text,
	"citation_key" text NOT NULL,
	"quote_text" text,
	"start_char" integer,
	"end_char" integer,
	"rank" integer,
	"score" double precision,
	"external_uri" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "citations_rank_check" CHECK ("citations"."rank" is null or "citations"."rank" > 0),
	CONSTRAINT "citations_position_check" CHECK ("citations"."start_char" is null or "citations"."end_char" is null or "citations"."start_char" <= "citations"."end_char"),
	CONSTRAINT "citations_target_check" CHECK ("citations"."chunk_id" is not null or "citations"."external_uri" is not null)
);
--> statement-breakpoint
CREATE TABLE "connector_action_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"action_type" text NOT NULL,
	"risk_level" text NOT NULL,
	"status" text NOT NULL,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_preview" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_id" text,
	"idempotency_key" text NOT NULL,
	"approved_by" text,
	"executed_by" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_action_runs_risk_level_check" CHECK ("connector_action_runs"."risk_level" in ('low', 'medium', 'high')),
	CONSTRAINT "connector_action_runs_status_check" CHECK ("connector_action_runs"."status" in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"provider_account_id" text,
	"provider_account_email" text,
	"display_name" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_refresh_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_oauth_accounts_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "connector_oauth_accounts_status_check" CHECK ("connector_oauth_accounts"."status" in ('active', 'reauth_required', 'revoked', 'disabled')),
	CONSTRAINT "connector_oauth_accounts_scopes_array_check" CHECK (jsonb_typeof("connector_oauth_accounts"."scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"redirect_after" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"indexed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_sync_runs_trigger_type_check" CHECK ("connector_sync_runs"."trigger_type" in ('manual', 'scheduled', 'webhook', 'backfill')),
	CONSTRAINT "connector_sync_runs_status_check" CHECK ("connector_sync_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'canceled', 'skipped')),
	CONSTRAINT "connector_sync_runs_discovered_count_check" CHECK ("connector_sync_runs"."discovered_count" >= 0),
	CONSTRAINT "connector_sync_runs_indexed_count_check" CHECK ("connector_sync_runs"."indexed_count" >= 0),
	CONSTRAINT "connector_sync_runs_failed_count_check" CHECK ("connector_sync_runs"."failed_count" >= 0)
);
--> statement-breakpoint
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
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision_id" text,
	"title" text,
	"language" text,
	"content_text" text NOT NULL,
	"token_count" integer,
	"char_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('pending', 'processing', 'ready', 'failed')),
	CONSTRAINT "documents_token_count_check" CHECK ("documents"."token_count" is null or "documents"."token_count" >= 0),
	CONSTRAINT "documents_char_count_check" CHECK ("documents"."char_count" is null or "documents"."char_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text,
	"job_type" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"queue_name" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_audit_status_check" CHECK ("jobs_audit"."status" in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "jobs_audit_attempts_check" CHECK ("jobs_audit"."attempts" >= 0)
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
	"input_json" jsonb,
	"output_json" jsonb,
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
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_message_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"model" text,
	"model_alias" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"provider_cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"credits_consumed" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "messages_input_tokens_check" CHECK ("messages"."input_tokens" is null or "messages"."input_tokens" >= 0),
	CONSTRAINT "messages_output_tokens_check" CHECK ("messages"."output_tokens" is null or "messages"."output_tokens" >= 0),
	CONSTRAINT "messages_total_tokens_check" CHECK ("messages"."total_tokens" is null or "messages"."total_tokens" >= 0),
	CONSTRAINT "messages_provider_cost_check" CHECK ("messages"."provider_cost_usd" is null or "messages"."provider_cost_usd" >= 0),
	CONSTRAINT "messages_latency_ms_check" CHECK ("messages"."latency_ms" is null or "messages"."latency_ms" >= 0),
	CONSTRAINT "messages_credits_consumed_check" CHECK ("messages"."credits_consumed" is null or "messages"."credits_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_gateway_byok_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"provider_name" text NOT NULL,
	"provider_kind" text DEFAULT 'openai-compatible' NOT NULL,
	"base_url" text,
	"credential_alias" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"default_headers_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_byok_credentials_kind_check" CHECK ("model_gateway_byok_credentials"."provider_kind" in ('openai-compatible', 'openrouter', 'deepinfra', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai'))
);
--> statement-breakpoint
CREATE TABLE "model_gateway_byok_models" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"provider_name" text NOT NULL,
	"model_name" text NOT NULL,
	"display_name" text NOT NULL,
	"model_type" text NOT NULL,
	"capabilities_json" jsonb,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_byok_models_type_check" CHECK ("model_gateway_byok_models"."model_type" in ('llm', 'image', 'vision'))
);
--> statement-breakpoint
CREATE TABLE "model_gateway_config_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version_hash" text NOT NULL,
	"source_path" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_gateway_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_byok" boolean DEFAULT false NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_configs_timeout_ms_check" CHECK ("model_gateway_configs"."timeout_ms" > 0),
	CONSTRAINT "model_gateway_configs_max_retries_check" CHECK ("model_gateway_configs"."max_retries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_gateway_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text,
	"span_id" text,
	"parent_span_id" text,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"message_id" text,
	"feature" text,
	"operation" text NOT NULL,
	"execution_mode" text,
	"key_source" text,
	"provider" text,
	"provider_model" text,
	"model_alias" text,
	"route_strategy" text,
	"success" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"provider_cost_usd" numeric(12, 6),
	"attributes_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_gateway_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"gateway_config_id" text NOT NULL,
	"profile_alias" text NOT NULL,
	"model_alias" text NOT NULL,
	"requested_dimensions" integer,
	"vector_strategy" text DEFAULT 'auto' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_profiles_kind_check" CHECK ("model_gateway_profiles"."kind" in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')),
	CONSTRAINT "model_gateway_profiles_vector_strategy_check" CHECK ("model_gateway_profiles"."vector_strategy" in ('auto', 'exact', 'disabled')),
	CONSTRAINT "model_gateway_profiles_requested_dimensions_check" CHECK ("model_gateway_profiles"."requested_dimensions" is null or ("model_gateway_profiles"."requested_dimensions" > 0 and "model_gateway_profiles"."requested_dimensions" <= 2000))
);
--> statement-breakpoint
CREATE TABLE "model_gateway_provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"config_version_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_kind" text NOT NULL,
	"gateway_config_id" text,
	"base_url" text NOT NULL,
	"api_key_source" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_provider_configs_kind_check" CHECK ("model_gateway_provider_configs"."provider_kind" in ('openai-compatible', 'openrouter', 'deepinfra', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai'))
);
--> statement-breakpoint
CREATE TABLE "model_gateway_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"config_version_id" text NOT NULL,
	"alias" text NOT NULL,
	"route_kind" text NOT NULL,
	"strategy" text DEFAULT 'priority' NOT NULL,
	"target_provider_name" text NOT NULL,
	"target_model" text NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"weight" integer DEFAULT 0 NOT NULL,
	"constraints_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_routes_kind_check" CHECK ("model_gateway_routes"."route_kind" in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')),
	CONSTRAINT "model_gateway_routes_strategy_check" CHECK ("model_gateway_routes"."strategy" in ('priority', 'weighted-random', 'least-latency', 'cost-aware', 'sticky-by-tenant')),
	CONSTRAINT "model_gateway_routes_priority_check" CHECK ("model_gateway_routes"."priority" > 0),
	CONSTRAINT "model_gateway_routes_weight_check" CHECK ("model_gateway_routes"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "note_sources" (
	"note_id" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "note_sources_note_id_source_id_pk" PRIMARY KEY("note_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"source_message_id" text,
	"note_type" text DEFAULT 'manual' NOT NULL,
	"title" text,
	"content_text" text,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_editable" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_note_type_check" CHECK ("notes"."note_type" in ('manual', 'saved_response', 'generated'))
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
CREATE TABLE "retrieval_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_stage" text NOT NULL,
	"hit_type" text NOT NULL,
	"source_id" text,
	"document_id" text,
	"chunk_id" text,
	"rank" integer NOT NULL,
	"score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_hits_source_stage_check" CHECK ("retrieval_hits"."source_stage" in ('bm25', 'vector', 'rrf', 'rerank')),
	CONSTRAINT "retrieval_hits_hit_type_check" CHECK ("retrieval_hits"."hit_type" in ('chunk', 'document')),
	CONSTRAINT "retrieval_hits_rank_check" CHECK ("retrieval_hits"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "retrieval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"message_id" text,
	"embedding_profile_id" text,
	"query_text" text NOT NULL,
	"embed_model_alias" text,
	"rerank_model_alias" text,
	"vector_strategy_used" text,
	"ann_index_used" text,
	"bm25_top_k" integer,
	"vector_top_k" integer,
	"rrf_k" integer,
	"prefilter_count" integer,
	"candidate_count" integer,
	"final_result_count" integer,
	"latency_ms" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_runs_vector_strategy_used_check" CHECK ("retrieval_runs"."vector_strategy_used" is null or "retrieval_runs"."vector_strategy_used" in ('ann_hnsw', 'exact_vector', 'bm25_only')),
	CONSTRAINT "retrieval_runs_bm25_top_k_check" CHECK ("retrieval_runs"."bm25_top_k" is null or "retrieval_runs"."bm25_top_k" > 0),
	CONSTRAINT "retrieval_runs_vector_top_k_check" CHECK ("retrieval_runs"."vector_top_k" is null or "retrieval_runs"."vector_top_k" > 0),
	CONSTRAINT "retrieval_runs_rrf_k_check" CHECK ("retrieval_runs"."rrf_k" is null or "retrieval_runs"."rrf_k" > 0),
	CONSTRAINT "retrieval_runs_prefilter_count_check" CHECK ("retrieval_runs"."prefilter_count" is null or "retrieval_runs"."prefilter_count" >= 0),
	CONSTRAINT "retrieval_runs_candidate_count_check" CHECK ("retrieval_runs"."candidate_count" is null or "retrieval_runs"."candidate_count" >= 0),
	CONSTRAINT "retrieval_runs_final_result_count_check" CHECK ("retrieval_runs"."final_result_count" is null or "retrieval_runs"."final_result_count" >= 0),
	CONSTRAINT "retrieval_runs_latency_ms_check" CHECK ("retrieval_runs"."latency_ms" is null or "retrieval_runs"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"access_level" text DEFAULT 'viewer' NOT NULL,
	"token" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_target_type_check" CHECK ("share_links"."target_type" in ('thread', 'artifact', 'chat_view')),
	CONSTRAINT "share_links_access_level_check" CHECK ("share_links"."access_level" in ('viewer', 'editor'))
);
--> statement-breakpoint
CREATE TABLE "skill_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"workspace_id" text,
	"source_type" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"visibility" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_definitions_source_type_check" CHECK ("skill_definitions"."source_type" in ('builtin', 'workspace_custom', 'team_custom')),
	CONSTRAINT "skill_definitions_visibility_check" CHECK ("skill_definitions"."visibility" in ('public', 'restricted', 'workspace', 'team')),
	CONSTRAINT "skill_definitions_status_check" CHECK ("skill_definitions"."status" in ('active', 'archived')),
	CONSTRAINT "skill_definitions_scope_check" CHECK (("skill_definitions"."source_type" = 'builtin' and "skill_definitions"."team_id" is null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" in ('public', 'restricted')) or ("skill_definitions"."source_type" = 'workspace_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is not null and "skill_definitions"."visibility" = 'workspace') or ("skill_definitions"."source_type" = 'team_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" = 'team'))
);
--> statement-breakpoint
CREATE TABLE "skill_entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"team_id" text,
	"workspace_id" text,
	"expires_at" timestamp with time zone,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_entitlements_scope_check" CHECK ("skill_entitlements"."team_id" is not null or "skill_entitlements"."workspace_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "skill_version_files" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_version_id" text NOT NULL,
	"path" text NOT NULL,
	"content_text" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_files_size_check" CHECK ("skill_version_files"."size_bytes" >= 0),
	CONSTRAINT "skill_version_files_relative_path_check" CHECK ("skill_version_files"."path" <> '' and "skill_version_files"."path" not like '/%' and "skill_version_files"."path" not like '../%' and "skill_version_files"."path" not like '%/../%')
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"storage_type" text NOT NULL,
	"storage_pointer" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"content_hash" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_status_check" CHECK ("skill_versions"."status" in ('draft', 'published', 'deprecated', 'disabled')),
	CONSTRAINT "skill_versions_storage_type_check" CHECK ("skill_versions"."storage_type" in ('repo_builtin', 'db_text'))
);
--> statement-breakpoint
CREATE TABLE "source_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"name" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"oauth_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"periodic_indexing_enabled" boolean DEFAULT false NOT NULL,
	"indexing_frequency_minutes" integer,
	"last_indexed_at" timestamp with time zone,
	"next_scheduled_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_connectors_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "source_connectors_status_check" CHECK ("source_connectors"."status" in ('active', 'paused', 'error', 'disabled')),
	CONSTRAINT "source_connectors_indexing_frequency_check" CHECK ("source_connectors"."indexing_frequency_minutes" is null or "source_connectors"."indexing_frequency_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision_no" integer NOT NULL,
	"content_hash" text,
	"storage_bucket" text,
	"storage_key" text,
	"external_updated_at" timestamp with time zone,
	"parser_version" text,
	"is_latest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revisions_revision_no_check" CHECK ("source_revisions"."revision_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"ingest_kind" text DEFAULT 'manual_upload' NOT NULL,
	"source_type" text DEFAULT 'manual_upload' NOT NULL,
	"connector_id" text,
	"sync_run_id" text,
	"parent_source_id" text,
	"title" text NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"external_id" text,
	"external_uri" text,
	"external_updated_at" timestamp with time zone,
	"mime_type" text,
	"size_bytes" bigint,
	"content_hash" text,
	"storage_bucket" text,
	"storage_key" text,
	"parser_version" text,
	"parsing_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"estimated_pages" integer,
	"parsed_tokens" integer,
	"error_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('created', 'queued', 'processing', 'indexed', 'failed', 'archived')),
	CONSTRAINT "sources_ingest_kind_check" CHECK ("sources"."ingest_kind" in ('connector', 'manual_upload', 'web_url', 'youtube', 'note', 'artifact')),
	CONSTRAINT "sources_source_type_check" CHECK ("sources"."source_type" in ('manual_upload', 'file_upload', 'web_url', 'youtube', 'note', 'artifact', 'connector', 'directory')),
	CONSTRAINT "sources_connector_requirement_check" CHECK (("sources"."ingest_kind" = 'connector' and "sources"."connector_id" is not null) or ("sources"."ingest_kind" <> 'connector' and "sources"."connector_id" is null)),
	CONSTRAINT "sources_estimated_pages_check" CHECK ("sources"."estimated_pages" is null or "sources"."estimated_pages" > 0),
	CONSTRAINT "sources_parsed_tokens_check" CHECK ("sources"."parsed_tokens" is null or "sources"."parsed_tokens" > 0),
	CONSTRAINT "sources_size_bytes_check" CHECK ("sources"."size_bytes" is null or "sources"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spend_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"scope" text DEFAULT 'team' NOT NULL,
	"actor_user_id" text,
	"soft_cap_usd" numeric(12, 4),
	"hard_cap_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_limits_soft_cap_check" CHECK ("spend_limits"."soft_cap_usd" is null or "spend_limits"."soft_cap_usd" >= 0),
	CONSTRAINT "spend_limits_hard_cap_check" CHECK ("spend_limits"."hard_cap_usd" is null or "spend_limits"."hard_cap_usd" >= 0),
	CONSTRAINT "spend_limits_hard_gte_soft_check" CHECK ("spend_limits"."soft_cap_usd" is null or "spend_limits"."hard_cap_usd" is null or "spend_limits"."hard_cap_usd" >= "spend_limits"."soft_cap_usd")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"provider" text DEFAULT 'none' NOT NULL,
	"plan_family" text NOT NULL,
	"status" text NOT NULL,
	"billing_interval" text DEFAULT 'unknown' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"external_customer_id" text,
	"external_subscription_id" text,
	"external_subscription_item_id" text,
	"external_product_id" text,
	"billing_order_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_team_id_uq" UNIQUE("team_id"),
	CONSTRAINT "subscriptions_provider_check" CHECK ("subscriptions"."provider" in ('none', 'creem', 'stripe', 'manual')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('inactive', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled', 'expired')),
	CONSTRAINT "subscriptions_billing_interval_check" CHECK ("subscriptions"."billing_interval" in ('monthly', 'yearly', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "team_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_profiles" (
	"team_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"billing_email" text,
	"plan_family" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_profiles_plan_family_check" CHECK ("team_profiles"."plan_family" is null or "team_profiles"."plan_family" in ('individual_free', 'individual_pro', 'team_standard', 'team_premium', 'enterprise_usage'))
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"model_settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "threads_visibility_check" CHECK ("threads"."visibility" in ('private', 'workspace', 'public_link'))
);
--> statement-breakpoint
CREATE TABLE "usage_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text,
	"actor_user_id" text,
	"feature" text NOT NULL,
	"event_type" text NOT NULL,
	"unit_type" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference_id" text,
	"idempotency_key" text,
	"operation_id" text,
	"operation_type" text,
	"activity_visible" boolean DEFAULT false NOT NULL,
	"activity_title" text,
	"activity_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledgers_event_type_check" CHECK ("usage_ledgers"."event_type" in ('grant', 'reserve', 'consume', 'release', 'refund', 'expire', 'adjust')),
	CONSTRAINT "usage_ledgers_unit_type_check" CHECK ("usage_ledgers"."unit_type" in ('credit', 'page', 'seat')),
	CONSTRAINT "usage_ledgers_operation_type_check" CHECK ("usage_ledgers"."operation_type" is null or "usage_ledgers"."operation_type" in ('seat_change', 'cycle_renewal', 'plan_change', 'topup', 'usage', 'quota_adjustment'))
);
--> statement-breakpoint
CREATE TABLE "working_files" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"path" text NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"mime_type" text DEFAULT 'text/plain' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"purpose" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_files_path_check" CHECK ("working_files"."path" ~ '^/work/[^[:cntrl:]]+$' and "working_files"."path" not like '%..%' and "working_files"."path" not like '%~%' and "working_files"."path" not like '%//%'),
	CONSTRAINT "working_files_purpose_check" CHECK ("working_files"."purpose" is null or "working_files"."purpose" in ('scratch', 'draft', 'note', 'output_candidate')),
	CONSTRAINT "working_files_size_bytes_check" CHECK ("working_files"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'workspace_admin' NOT NULL,
	"source" text DEFAULT 'direct' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_memberships_role_check" CHECK ("workspace_memberships"."role" in ('workspace_admin', 'editor', 'viewer')),
	CONSTRAINT "workspace_memberships_source_check" CHECK ("workspace_memberships"."source" in ('direct', 'inherited'))
);
--> statement-breakpoint
CREATE TABLE "workspace_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_by" text,
	"enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_id_organization_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "artifact_sources" ADD CONSTRAINT "artifact_sources_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_sources" ADD CONSTRAINT "artifact_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_sources" ADD CONSTRAINT "artifact_sources_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_sources" ADD CONSTRAINT "artifact_sources_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_parent_version_id_artifact_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_embedding_profile_id_model_gateway_profiles_id_fk" FOREIGN KEY ("embedding_profile_id") REFERENCES "public"."model_gateway_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_workspace_team_fk" FOREIGN KEY ("document_id","workspace_id","team_id") REFERENCES "public"."documents"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_accounts" ADD CONSTRAINT "connector_oauth_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_accounts" ADD CONSTRAINT "connector_oauth_accounts_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_sync_run_id_connector_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."connector_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_events" ADD CONSTRAINT "connector_webhook_events_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_workspace_team_fk" FOREIGN KEY ("source_id","workspace_id","team_id") REFERENCES "public"."sources"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs_audit" ADD CONSTRAINT "jobs_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs_audit" ADD CONSTRAINT "jobs_audit_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_audit_access_logs" ADD CONSTRAINT "llm_audit_access_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_audit_access_logs" ADD CONSTRAINT "llm_audit_access_logs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback_scores" ADD CONSTRAINT "llm_feedback_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback_scores" ADD CONSTRAINT "llm_feedback_scores_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spans" ADD CONSTRAINT "llm_spans_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD CONSTRAINT "llm_traces_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_credentials" ADD CONSTRAINT "model_gateway_byok_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_credentials" ADD CONSTRAINT "model_gateway_byok_credentials_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_credential_id_model_gateway_byok_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."model_gateway_byok_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_events" ADD CONSTRAINT "model_gateway_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_events" ADD CONSTRAINT "model_gateway_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_events" ADD CONSTRAINT "model_gateway_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_events" ADD CONSTRAINT "model_gateway_events_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_profiles" ADD CONSTRAINT "model_gateway_profiles_gateway_config_id_model_gateway_configs_id_fk" FOREIGN KEY ("gateway_config_id") REFERENCES "public"."model_gateway_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_provider_configs" ADD CONSTRAINT "model_gateway_provider_configs_config_version_id_model_gateway_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."model_gateway_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_provider_configs" ADD CONSTRAINT "model_gateway_provider_configs_gateway_config_id_model_gateway_configs_id_fk" FOREIGN KEY ("gateway_config_id") REFERENCES "public"."model_gateway_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_routes" ADD CONSTRAINT "model_gateway_routes_config_version_id_model_gateway_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."model_gateway_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_sources" ADD CONSTRAINT "note_sources_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_sources" ADD CONSTRAINT "note_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_hits" ADD CONSTRAINT "retrieval_hits_run_id_retrieval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."retrieval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_hits" ADD CONSTRAINT "retrieval_hits_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_hits" ADD CONSTRAINT "retrieval_hits_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_hits" ADD CONSTRAINT "retrieval_hits_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_runs" ADD CONSTRAINT "retrieval_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_runs" ADD CONSTRAINT "retrieval_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_runs" ADD CONSTRAINT "retrieval_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_runs" ADD CONSTRAINT "retrieval_runs_embedding_profile_id_model_gateway_profiles_id_fk" FOREIGN KEY ("embedding_profile_id") REFERENCES "public"."model_gateway_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_runs" ADD CONSTRAINT "retrieval_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_oauth_account_id_connector_oauth_accounts_id_fk" FOREIGN KEY ("oauth_account_id") REFERENCES "public"."connector_oauth_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_oauth_account_workspace_team_fk" FOREIGN KEY ("oauth_account_id","workspace_id","team_id") REFERENCES "public"."connector_oauth_accounts"("id","workspace_id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_source_workspace_team_fk" FOREIGN KEY ("source_id","workspace_id","team_id") REFERENCES "public"."sources"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_sync_run_id_connector_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."connector_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_sources_artifact_idx" ON "artifact_sources" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_sources_source_idx" ON "artifact_sources" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_artifact_version_uq" ON "artifact_versions" USING btree ("artifact_id","version_no");--> statement-breakpoint
CREATE INDEX "artifact_versions_artifact_created_idx" ON "artifact_versions" USING btree ("artifact_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "artifacts_workspace_status_created_idx" ON "artifacts" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "artifacts_thread_created_idx" ON "artifacts" USING btree ("thread_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_orders_provider_checkout_uq" ON "billing_orders" USING btree ("provider","external_checkout_id") WHERE "billing_orders"."external_checkout_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_orders_user_reference_uq" ON "billing_orders" USING btree ("user_id","client_reference_key") WHERE "billing_orders"."client_reference_key" is not null;--> statement-breakpoint
CREATE INDEX "billing_orders_user_status_created_idx" ON "billing_orders" USING btree ("user_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "billing_orders_team_status_created_idx" ON "billing_orders" USING btree ("team_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "billing_orders_status_retry_idx" ON "billing_orders" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_uq" ON "billing_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_team_status_idx" ON "billing_webhook_events" USING btree ("team_id","status","received_at" desc);--> statement-breakpoint
CREATE INDEX "billing_webhook_events_status_received_idx" ON "billing_webhook_events" USING btree ("status","received_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_idempotency_uq" ON "chat_thread_runs" USING btree ("team_id","workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_thread_active_uq" ON "chat_thread_runs" USING btree ("team_id","workspace_id","thread_id") WHERE "chat_thread_runs"."status" in ('queued', 'running', 'cancel_requested');--> statement-breakpoint
CREATE INDEX "chat_thread_runs_thread_status_created_idx" ON "chat_thread_runs" USING btree ("team_id","workspace_id","thread_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "chat_thread_runs_job_idx" ON "chat_thread_runs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_embeddings_chunk_profile_uq" ON "chunk_embeddings" USING btree ("chunk_id","embedding_profile_id");--> statement-breakpoint
CREATE INDEX "chunk_embeddings_workspace_profile_created_idx" ON "chunk_embeddings" USING btree ("workspace_id","embedding_profile_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "chunk_embeddings_chunk_created_idx" ON "chunk_embeddings" USING btree ("chunk_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_chunk_no_uq" ON "chunks" USING btree ("document_id","chunk_no");--> statement-breakpoint
CREATE INDEX "chunks_workspace_document_chunk_idx" ON "chunks" USING btree ("workspace_id","document_id","chunk_no");--> statement-breakpoint
CREATE INDEX "chunks_source_chunk_idx" ON "chunks" USING btree ("source_id","chunk_no");--> statement-breakpoint
CREATE UNIQUE INDEX "citations_message_key_uq" ON "citations" USING btree ("message_id","citation_key");--> statement-breakpoint
CREATE INDEX "citations_message_rank_idx" ON "citations" USING btree ("message_id","rank");--> statement-breakpoint
CREATE INDEX "citations_chunk_idx" ON "citations" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "citations_source_document_idx" ON "citations" USING btree ("source_id","document_id");--> statement-breakpoint
CREATE INDEX "connector_action_runs_connector_created_idx" ON "connector_action_runs" USING btree ("connector_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_action_runs_workspace_status_created_idx" ON "connector_action_runs" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_action_runs_idempotency_uq" ON "connector_action_runs" USING btree ("workspace_id","connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "connector_oauth_accounts_workspace_type_status_idx" ON "connector_oauth_accounts" USING btree ("workspace_id","connector_type","status");--> statement-breakpoint
CREATE INDEX "connector_oauth_accounts_team_workspace_created_idx" ON "connector_oauth_accounts" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_states_state_hash_uq" ON "connector_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "connector_oauth_states_workspace_user_created_idx" ON "connector_oauth_states" USING btree ("workspace_id","user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_oauth_states_expires_idx" ON "connector_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connector_sync_runs_connector_created_idx" ON "connector_sync_runs" USING btree ("connector_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_sync_runs_workspace_status_created_idx" ON "connector_sync_runs" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_webhook_events_provider_event_uq" ON "connector_webhook_events" USING btree ("connector_type","provider_event_id");--> statement-breakpoint
CREATE INDEX "connector_webhook_events_workspace_created_idx" ON "connector_webhook_events" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_webhook_events_connector_created_idx" ON "connector_webhook_events" USING btree ("connector_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_webhook_events_status_received_idx" ON "connector_webhook_events" USING btree ("status","received_at" desc);--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_updated_idx" ON "documents" USING btree ("workspace_id","updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_audit_team_idempotency_uq" ON "jobs_audit" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_audit_workspace_status_created_idx" ON "jobs_audit" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "jobs_audit_team_status_created_idx" ON "jobs_audit" USING btree ("team_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_team_workspace_idx" ON "llm_audit_access_logs" USING btree ("team_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_actor_idx" ON "llm_audit_access_logs" USING btree ("team_id","actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_audit_access_logs_target_idx" ON "llm_audit_access_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_trace_idx" ON "llm_feedback_scores" USING btree ("trace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_generation_idx" ON "llm_feedback_scores" USING btree ("generation_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_feedback_scores_team_workspace_idx" ON "llm_feedback_scores" USING btree ("team_id","workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_generations_scope_trace_span_uq" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","span_id");--> statement-breakpoint
CREATE INDEX "llm_generations_trace_idx" ON "llm_generations" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_scope_trace_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_scope_trace_started_id_idx" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","started_at","id");--> statement-breakpoint
CREATE INDEX "llm_generations_parent_idx" ON "llm_generations" USING btree ("trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_scope_parent_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_team_workspace_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_team_workspace_started_id_idx" ON "llm_generations" USING btree ("team_id","workspace_id","started_at","id");--> statement-breakpoint
CREATE INDEX "llm_generations_operation_started_idx" ON "llm_generations" USING btree ("operation","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_provider_started_idx" ON "llm_generations" USING btree ("provider","provider_model","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_status_started_idx" ON "llm_generations" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_message_idx" ON "llm_generations" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_spans_scope_trace_span_uq" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","span_id");--> statement-breakpoint
CREATE INDEX "llm_spans_trace_idx" ON "llm_spans" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_scope_trace_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_scope_trace_started_id_idx" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","started_at","id");--> statement-breakpoint
CREATE INDEX "llm_spans_parent_idx" ON "llm_spans" USING btree ("trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_scope_parent_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_team_workspace_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_spans_kind_started_idx" ON "llm_spans" USING btree ("kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_traces_scope_trace_uq" ON "llm_traces" USING btree ("team_id","workspace_id","trace_id");--> statement-breakpoint
CREATE INDEX "llm_traces_trace_idx" ON "llm_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "llm_traces_team_workspace_started_idx" ON "llm_traces" USING btree ("team_id","workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_team_workspace_started_id_idx" ON "llm_traces" USING btree ("team_id","workspace_id","started_at","id");--> statement-breakpoint
CREATE INDEX "llm_traces_team_started_idx" ON "llm_traces" USING btree ("team_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_team_started_id_idx" ON "llm_traces" USING btree ("team_id","started_at","id");--> statement-breakpoint
CREATE INDEX "llm_traces_thread_started_idx" ON "llm_traces" USING btree ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_traces_message_idx" ON "llm_traces" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "llm_traces_status_started_idx" ON "llm_traces" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_scope_thread_created_id_idx" ON "messages" USING btree ("team_id","workspace_id","thread_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "messages_thread_role_created_idx" ON "messages" USING btree ("thread_id","role","created_at");--> statement-breakpoint
CREATE INDEX "messages_parent_message_idx" ON "messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "messages_team_workspace_created_idx" ON "messages" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "model_gateway_byok_credentials_lookup_idx" ON "model_gateway_byok_credentials" USING btree ("team_id","workspace_id","user_id","provider_name","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_byok_credentials_alias_uq" ON "model_gateway_byok_credentials" USING btree ("workspace_id","user_id","provider_name","credential_alias");--> statement-breakpoint
CREATE INDEX "model_gateway_byok_models_credential_idx" ON "model_gateway_byok_models" USING btree ("credential_id","is_active");--> statement-breakpoint
CREATE INDEX "model_gateway_byok_models_lookup_idx" ON "model_gateway_byok_models" USING btree ("team_id","workspace_id","user_id","provider_name","model_type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_byok_models_credential_model_uq" ON "model_gateway_byok_models" USING btree ("workspace_id","user_id","credential_id","model_name","model_type");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_config_versions_hash_uq" ON "model_gateway_config_versions" USING btree ("version_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_config_versions_active_uq" ON "model_gateway_config_versions" USING btree ("is_active") WHERE "model_gateway_config_versions"."is_active" = true;--> statement-breakpoint
CREATE INDEX "model_gateway_config_versions_created_idx" ON "model_gateway_config_versions" USING btree ("created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_configs_slug_uq" ON "model_gateway_configs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_configs_default_uq" ON "model_gateway_configs" USING btree ("is_default") WHERE "model_gateway_configs"."is_default" = true;--> statement-breakpoint
CREATE INDEX "model_gateway_configs_default_active_idx" ON "model_gateway_configs" USING btree ("is_default","is_active");--> statement-breakpoint
CREATE INDEX "model_gateway_events_trace_idx" ON "model_gateway_events" USING btree ("trace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_gateway_events_provider_idx" ON "model_gateway_events" USING btree ("provider","operation","created_at");--> statement-breakpoint
CREATE INDEX "model_gateway_events_team_workspace_idx" ON "model_gateway_events" USING btree ("team_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_gateway_events_team_provider_idx" ON "model_gateway_events" USING btree ("team_id","provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_profiles_alias_uq" ON "model_gateway_profiles" USING btree ("profile_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_profiles_default_kind_uq" ON "model_gateway_profiles" USING btree ("kind") WHERE "model_gateway_profiles"."is_default" = true;--> statement-breakpoint
CREATE INDEX "model_gateway_profiles_kind_default_active_idx" ON "model_gateway_profiles" USING btree ("kind","is_default","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_provider_configs_version_name_uq" ON "model_gateway_provider_configs" USING btree ("config_version_id","provider_name");--> statement-breakpoint
CREATE INDEX "model_gateway_provider_configs_active_idx" ON "model_gateway_provider_configs" USING btree ("config_version_id","is_active");--> statement-breakpoint
CREATE INDEX "model_gateway_routes_lookup_idx" ON "model_gateway_routes" USING btree ("config_version_id","alias","route_kind","is_active");--> statement-breakpoint
CREATE INDEX "note_sources_source_idx" ON "note_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_updated_idx" ON "notes" USING btree ("workspace_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "notes_thread_updated_idx" ON "notes" USING btree ("thread_id","updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_alert_key_uq" ON "ops_alerts" USING btree ("alert_key");--> statement-breakpoint
CREATE INDEX "ops_alerts_level_status_triggered_idx" ON "ops_alerts" USING btree ("level","status","last_triggered_at" desc);--> statement-breakpoint
CREATE INDEX "ops_alerts_source_triggered_idx" ON "ops_alerts" USING btree ("source","last_triggered_at" desc);--> statement-breakpoint
CREATE INDEX "retrieval_hits_run_stage_rank_idx" ON "retrieval_hits" USING btree ("run_id","source_stage","rank");--> statement-breakpoint
CREATE INDEX "retrieval_hits_run_created_idx" ON "retrieval_hits" USING btree ("run_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "retrieval_runs_workspace_created_idx" ON "retrieval_runs" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "retrieval_runs_thread_created_idx" ON "retrieval_runs" USING btree ("thread_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "retrieval_runs_message_created_idx" ON "retrieval_runs" USING btree ("message_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "retrieval_runs_profile_created_idx" ON "retrieval_runs" USING btree ("embedding_profile_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_uq" ON "share_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "share_links_target_idx" ON "share_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "share_links_team_created_idx" ON "share_links" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_slug_uq" ON "skill_definitions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skill_definitions_team_workspace_status_idx" ON "skill_definitions" USING btree ("team_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "skill_entitlements_skill_idx" ON "skill_entitlements" USING btree ("skill_id","team_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_version_files_version_path_uq" ON "skill_version_files" USING btree ("skill_version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uq" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_current_uq" ON "skill_versions" USING btree ("skill_id") WHERE "skill_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "skill_versions_skill_status_idx" ON "skill_versions" USING btree ("skill_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_connectors_workspace_type_name_uq" ON "source_connectors" USING btree ("workspace_id","connector_type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "source_connectors_oauth_account_uq" ON "source_connectors" USING btree ("oauth_account_id") WHERE "source_connectors"."oauth_account_id" is not null;--> statement-breakpoint
CREATE INDEX "source_connectors_team_workspace_status_next_idx" ON "source_connectors" USING btree ("team_id","workspace_id","status","next_scheduled_at");--> statement-breakpoint
CREATE INDEX "source_connectors_workspace_created_idx" ON "source_connectors" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_source_revision_uq" ON "source_revisions" USING btree ("source_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_source_latest_uq" ON "source_revisions" USING btree ("source_id") WHERE "source_revisions"."is_latest" = true;--> statement-breakpoint
CREATE INDEX "source_revisions_source_latest_idx" ON "source_revisions" USING btree ("source_id","is_latest","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "sources_connector_external_id_uq" ON "sources" USING btree ("connector_id","external_id") WHERE "sources"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "sources_team_workspace_status_updated_idx" ON "sources" USING btree ("team_id","workspace_id","status","updated_at" desc);--> statement-breakpoint
CREATE INDEX "sources_team_workspace_updated_id_idx" ON "sources" USING btree ("team_id","workspace_id","updated_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "sources_team_workspace_parent_idx" ON "sources" USING btree ("team_id","workspace_id","parent_source_id");--> statement-breakpoint
CREATE INDEX "sources_team_workspace_parent_updated_id_idx" ON "sources" USING btree ("team_id","workspace_id","parent_source_id","updated_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "sources_workspace_created_idx" ON "sources" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "spend_limits_team_scope_user_uq" ON "spend_limits" USING btree ("team_id","scope",coalesce("actor_user_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_external_subscription_uq" ON "subscriptions" USING btree ("provider","external_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_billing_order_idx" ON "subscriptions" USING btree ("billing_order_id");--> statement-breakpoint
CREATE INDEX "team_audit_logs_team_created_idx" ON "team_audit_logs" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "team_audit_logs_team_actor_created_idx" ON "team_audit_logs" USING btree ("team_id","actor_user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "threads_team_workspace_created_idx" ON "threads" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "threads_workspace_last_message_idx" ON "threads" USING btree ("workspace_id","last_message_at" desc);--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_created_idx" ON "usage_ledgers" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_activity_created_idx" ON "usage_ledgers" USING btree ("team_id","created_at" desc) WHERE "usage_ledgers"."activity_visible" = true;--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_workspace_created_idx" ON "usage_ledgers" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledgers_team_idempotency_uq" ON "usage_ledgers" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledgers_team_operation_visible_uq" ON "usage_ledgers" USING btree ("team_id","operation_id") WHERE "usage_ledgers"."activity_visible" = true and "usage_ledgers"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "working_files_thread_path_uq" ON "working_files" USING btree ("team_id","workspace_id","thread_id","path");--> statement-breakpoint
CREATE INDEX "working_files_thread_updated_idx" ON "working_files" USING btree ("team_id","workspace_id","thread_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_workspace_role_idx" ON "workspace_memberships" USING btree ("workspace_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_skills_skill_uq" ON "workspace_skills" USING btree ("workspace_id","skill_id");--> statement-breakpoint
CREATE INDEX "workspace_skills_workspace_enabled_idx" ON "workspace_skills" USING btree ("team_id","workspace_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_slug_uq" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_org_created_idx" ON "workspaces" USING btree ("organization_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "workspaces_org_updated_idx" ON "workspaces" USING btree ("organization_id","updated_at" desc);
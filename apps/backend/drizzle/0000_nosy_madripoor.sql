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
	CONSTRAINT "artifacts_artifact_type_check" CHECK ("artifacts"."artifact_type" in ('report', 'slides', 'mindmap', 'podcast', 'audio_overview', 'video_overview', 'flashcards', 'quiz', 'table', 'infographic')),
	CONSTRAINT "artifacts_status_check" CHECK ("artifacts"."status" in ('pending', 'running', 'ready', 'failed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"team_id" text PRIMARY KEY NOT NULL,
	"plan_family" text NOT NULL,
	"cycle_anchor_day" integer DEFAULT 1 NOT NULL,
	"cycle_start_at" timestamp with time zone NOT NULL,
	"cycle_end_at" timestamp with time zone NOT NULL,
	"pages_limit" integer NOT NULL,
	"pages_used" integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "billing_accounts_cycle_anchor_day_check" CHECK ("billing_accounts"."cycle_anchor_day" between 1 and 28),
	CONSTRAINT "billing_accounts_pages_limit_check" CHECK ("billing_accounts"."pages_limit" >= 0),
	CONSTRAINT "billing_accounts_pages_used_check" CHECK ("billing_accounts"."pages_used" >= 0),
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
	CONSTRAINT "connector_sync_runs_status_check" CHECK ("connector_sync_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "connector_sync_runs_discovered_count_check" CHECK ("connector_sync_runs"."discovered_count" >= 0),
	CONSTRAINT "connector_sync_runs_indexed_count_check" CHECK ("connector_sync_runs"."indexed_count" >= 0),
	CONSTRAINT "connector_sync_runs_failed_count_check" CHECK ("connector_sync_runs"."failed_count" >= 0)
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
CREATE TABLE "model_gateway_byok_key_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"provider_name" text NOT NULL,
	"key_ref" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	CONSTRAINT "model_gateway_provider_configs_kind_check" CHECK ("model_gateway_provider_configs"."provider_kind" in ('openai-compatible', 'openrouter', 'deepinfra', 'openai', 'anthropic', 'gemini', 'azure-openai'))
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
CREATE TABLE "source_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"name" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
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
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"external_customer_id" text,
	"external_subscription_id" text,
	"external_product_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_team_id_uq" UNIQUE("team_id"),
	CONSTRAINT "subscriptions_provider_check" CHECK ("subscriptions"."provider" in ('none', 'creem', 'stripe', 'manual')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('inactive', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled', 'expired'))
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
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledgers_event_type_check" CHECK ("usage_ledgers"."event_type" in ('grant', 'reserve', 'consume', 'release', 'refund', 'expire', 'adjust')),
	CONSTRAINT "usage_ledgers_unit_type_check" CHECK ("usage_ledgers"."unit_type" in ('credit', 'page'))
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
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_workspace_team_fk" FOREIGN KEY ("source_id","workspace_id","team_id") REFERENCES "public"."sources"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs_audit" ADD CONSTRAINT "jobs_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs_audit" ADD CONSTRAINT "jobs_audit_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_key_refs" ADD CONSTRAINT "model_gateway_byok_key_refs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_byok_key_refs" ADD CONSTRAINT "model_gateway_byok_key_refs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_sources_artifact_idx" ON "artifact_sources" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_sources_source_idx" ON "artifact_sources" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_artifact_version_uq" ON "artifact_versions" USING btree ("artifact_id","version_no");--> statement-breakpoint
CREATE INDEX "artifact_versions_artifact_created_idx" ON "artifact_versions" USING btree ("artifact_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "artifacts_workspace_status_created_idx" ON "artifacts" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "artifacts_thread_created_idx" ON "artifacts" USING btree ("thread_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_uq" ON "billing_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_team_status_idx" ON "billing_webhook_events" USING btree ("team_id","status","received_at" desc);--> statement-breakpoint
CREATE INDEX "billing_webhook_events_status_received_idx" ON "billing_webhook_events" USING btree ("status","received_at" desc);--> statement-breakpoint
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
CREATE INDEX "connector_sync_runs_connector_created_idx" ON "connector_sync_runs" USING btree ("connector_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "connector_sync_runs_workspace_status_created_idx" ON "connector_sync_runs" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_updated_idx" ON "documents" USING btree ("workspace_id","updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_audit_team_idempotency_uq" ON "jobs_audit" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_audit_workspace_status_created_idx" ON "jobs_audit" USING btree ("workspace_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "jobs_audit_team_status_created_idx" ON "jobs_audit" USING btree ("team_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_role_created_idx" ON "messages" USING btree ("thread_id","role","created_at");--> statement-breakpoint
CREATE INDEX "messages_parent_message_idx" ON "messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "messages_team_workspace_created_idx" ON "messages" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "model_gateway_byok_key_refs_lookup_idx" ON "model_gateway_byok_key_refs" USING btree ("team_id","workspace_id","user_id","provider_name","key_ref","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_byok_key_refs_scope_uq" ON "model_gateway_byok_key_refs" USING btree ("workspace_id","user_id","provider_name","key_ref");--> statement-breakpoint
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
CREATE UNIQUE INDEX "source_connectors_workspace_type_name_uq" ON "source_connectors" USING btree ("workspace_id","connector_type","name");--> statement-breakpoint
CREATE INDEX "source_connectors_team_workspace_status_next_idx" ON "source_connectors" USING btree ("team_id","workspace_id","status","next_scheduled_at");--> statement-breakpoint
CREATE INDEX "source_connectors_workspace_created_idx" ON "source_connectors" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_source_revision_uq" ON "source_revisions" USING btree ("source_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_source_latest_uq" ON "source_revisions" USING btree ("source_id") WHERE "source_revisions"."is_latest" = true;--> statement-breakpoint
CREATE INDEX "source_revisions_source_latest_idx" ON "source_revisions" USING btree ("source_id","is_latest","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "sources_connector_external_id_uq" ON "sources" USING btree ("connector_id","external_id") WHERE "sources"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_content_hash_uq" ON "sources" USING btree ("workspace_id","content_hash") WHERE "sources"."content_hash" is not null;--> statement-breakpoint
CREATE INDEX "sources_team_workspace_status_updated_idx" ON "sources" USING btree ("team_id","workspace_id","status","updated_at" desc);--> statement-breakpoint
CREATE INDEX "sources_workspace_created_idx" ON "sources" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "spend_limits_team_scope_user_uq" ON "spend_limits" USING btree ("team_id","scope",coalesce("actor_user_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_external_subscription_uq" ON "subscriptions" USING btree ("provider","external_subscription_id");--> statement-breakpoint
CREATE INDEX "team_audit_logs_team_created_idx" ON "team_audit_logs" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "team_audit_logs_team_actor_created_idx" ON "team_audit_logs" USING btree ("team_id","actor_user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "threads_team_workspace_created_idx" ON "threads" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "threads_workspace_last_message_idx" ON "threads" USING btree ("workspace_id","last_message_at" desc);--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_created_idx" ON "usage_ledgers" USING btree ("team_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_workspace_created_idx" ON "usage_ledgers" USING btree ("team_id","workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledgers_team_idempotency_uq" ON "usage_ledgers" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_workspace_role_idx" ON "workspace_memberships" USING btree ("workspace_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_slug_uq" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_org_created_idx" ON "workspaces" USING btree ("organization_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "workspaces_org_updated_idx" ON "workspaces" USING btree ("organization_id","updated_at" desc);

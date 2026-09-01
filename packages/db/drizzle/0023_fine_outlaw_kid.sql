ALTER TABLE "llm_generations" ALTER COLUMN "provider_cost_usd" SET DATA TYPE numeric(18, 12);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "provider_cost_usd" SET DATA TYPE numeric(18, 12);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "resolved_provider_model" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "profile_alias" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "gateway_config_id" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "provider_cost_inline_usd" numeric(18, 12);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "provider_cost_settled_usd" numeric(18, 12);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "provider_cost_source" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "provider_cost_status" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "cost_currency" text;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "provider_receipt_json" jsonb;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "cost_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD COLUMN "normalization_json" jsonb;--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_gateway_config_id_model_gateway_configs_id_fk" FOREIGN KEY ("gateway_config_id") REFERENCES "public"."model_gateway_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_generations_provider_resolved_model_started_idx" ON "llm_generations" USING btree ("provider","resolved_provider_model","started_at");--> statement-breakpoint
CREATE INDEX "llm_generations_provider_request_idx" ON "llm_generations" USING btree ("provider","provider_request_id");--> statement-breakpoint
CREATE INDEX "llm_generations_cost_status_ended_idx" ON "llm_generations" USING btree ("provider_cost_status","ended_at");--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_reasoning_tokens_check" CHECK ("llm_generations"."reasoning_tokens" is null or "llm_generations"."reasoning_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_cache_read_tokens_check" CHECK ("llm_generations"."cache_read_tokens" is null or "llm_generations"."cache_read_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_cache_write_tokens_check" CHECK ("llm_generations"."cache_write_tokens" is null or "llm_generations"."cache_write_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_provider_cost_check" CHECK ("llm_generations"."provider_cost_usd" is null or "llm_generations"."provider_cost_usd" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_provider_cost_inline_check" CHECK ("llm_generations"."provider_cost_inline_usd" is null or "llm_generations"."provider_cost_inline_usd" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_provider_cost_settled_check" CHECK ("llm_generations"."provider_cost_settled_usd" is null or "llm_generations"."provider_cost_settled_usd" >= 0);--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_provider_cost_source_check" CHECK ("llm_generations"."provider_cost_source" is null or "llm_generations"."provider_cost_source" in ('provider_inline', 'provider_receipt', 'provider_estimated', 'price_book', 'temporary_minimum', 'legacy', 'missing'));--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_provider_cost_status_check" CHECK ("llm_generations"."provider_cost_status" is null or "llm_generations"."provider_cost_status" in ('pending', 'inline', 'settled', 'estimated', 'legacy', 'missing', 'reconcile_failed'));--> statement-breakpoint
ALTER TABLE "llm_generations" ADD CONSTRAINT "llm_generations_cost_currency_check" CHECK ("llm_generations"."cost_currency" is null or "llm_generations"."cost_currency" = 'USD');

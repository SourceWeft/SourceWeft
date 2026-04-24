ALTER TABLE "model_gateway_profiles" DROP CONSTRAINT IF EXISTS "model_gateway_profiles_kind_check";
--> statement-breakpoint
ALTER TABLE "model_gateway_profiles"
ADD CONSTRAINT "model_gateway_profiles_kind_check"
CHECK ("model_gateway_profiles"."kind" in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video'));
--> statement-breakpoint
ALTER TABLE "model_gateway_routes" DROP CONSTRAINT IF EXISTS "model_gateway_routes_kind_check";
--> statement-breakpoint
ALTER TABLE "model_gateway_routes"
ADD CONSTRAINT "model_gateway_routes_kind_check"
CHECK ("model_gateway_routes"."route_kind" in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video'));
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "model_settings_json" jsonb;
--> statement-breakpoint
UPDATE "threads"
SET "model_settings_json" = '{}'::jsonb
WHERE "model_settings_json" IS NULL;
--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "model_settings_json" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "model_settings_json" SET NOT NULL;

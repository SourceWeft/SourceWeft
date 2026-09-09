CREATE TABLE "billing_provider_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"merchant_id" text NOT NULL,
	"environment" text NOT NULL,
	"store_id" text NOT NULL,
	"products" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_settings_environment_check" CHECK ("billing_provider_settings"."environment" in ('test', 'prod'))
);
--> statement-breakpoint
ALTER TABLE "billing_orders" DROP CONSTRAINT "billing_orders_provider_check";--> statement-breakpoint
ALTER TABLE "billing_webhook_events" DROP CONSTRAINT "billing_webhook_events_provider_check";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_provider_check";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_settings_merchant_env_uq" ON "billing_provider_settings" USING btree ("provider","merchant_id","environment");--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_provider_check" CHECK ("billing_orders"."provider" in ('none', 'creem', 'waffo', 'stripe', 'manual'));--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_provider_check" CHECK ("billing_webhook_events"."provider" in ('none', 'creem', 'waffo', 'stripe', 'manual'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_provider_check" CHECK ("subscriptions"."provider" in ('none', 'creem', 'waffo', 'stripe', 'manual'));
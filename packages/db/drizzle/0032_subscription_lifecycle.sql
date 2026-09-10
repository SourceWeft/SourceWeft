CREATE TABLE "billing_subscription_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"identity" text NOT NULL,
	"team_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_subscription_id" text,
	"order_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_bindings_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "billing_subscription_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"kind" text NOT NULL,
	"request_hash" text NOT NULL,
	"order_id" text,
	"status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_operations_status_check" CHECK ("billing_subscription_operations"."status" in ('reserved','remote_pending','awaiting_confirmation','needs_resolution','succeeded','failed')),
	CONSTRAINT "billing_subscription_operations_kind_check" CHECK ("billing_subscription_operations"."kind" in ('purchase','seats'))
);
--> statement-breakpoint
DROP INDEX "subscriptions_provider_external_subscription_uq";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "subscription_binding_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "current_binding_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "confirmed_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "confirmed_period_end" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_operations_open_uq" ON "billing_subscription_operations" USING btree ("target_key") WHERE "billing_subscription_operations"."status" in ('reserved','remote_pending','awaiting_confirmation','needs_resolution');--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_current_binding_uq" ON "subscriptions" USING btree ("current_binding_id");
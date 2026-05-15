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
CREATE UNIQUE INDEX "billing_orders_provider_checkout_uq" ON "billing_orders" USING btree ("provider", "external_checkout_id") WHERE "external_checkout_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_orders_user_reference_uq" ON "billing_orders" USING btree ("user_id", "client_reference_key") WHERE "client_reference_key" is not null;
--> statement-breakpoint
CREATE INDEX "billing_orders_user_status_created_idx" ON "billing_orders" USING btree ("user_id", "status", "created_at" desc);
--> statement-breakpoint
CREATE INDEX "billing_orders_team_status_created_idx" ON "billing_orders" USING btree ("team_id", "status", "created_at" desc);
--> statement-breakpoint
CREATE INDEX "billing_orders_status_retry_idx" ON "billing_orders" USING btree ("status", "next_retry_at");
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "external_subscription_item_id" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_order_id" text;
--> statement-breakpoint
CREATE INDEX "subscriptions_billing_order_idx" ON "subscriptions" USING btree ("billing_order_id");

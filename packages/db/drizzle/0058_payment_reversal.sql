ALTER TABLE "usage_ledgers" DROP CONSTRAINT "usage_ledgers_operation_type_check";--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "refunded_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "reversed_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "reversal_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_orders_provider_payment_idx" ON "billing_orders" USING btree ("provider","external_payment_id") WHERE "billing_orders"."external_payment_id" is not null;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_refunded_amount_check" CHECK ("billing_orders"."refunded_amount" >= 0);--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_reversed_units_check" CHECK ("billing_orders"."reversed_units" >= 0 and "billing_orders"."reversed_units" <= "billing_orders"."granted_credits" + "billing_orders"."granted_pages");--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_reversal_status_check" CHECK ("billing_orders"."reversal_status" in ('none', 'partially_refunded', 'refunded', 'charged_back'));--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_operation_type_check" CHECK ("usage_ledgers"."operation_type" is null or "usage_ledgers"."operation_type" in ('seat_change', 'cycle_renewal', 'plan_change', 'topup', 'usage', 'quota_adjustment', 'payment_reversal'));
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" text DEFAULT 'unknown' NOT NULL;

UPDATE "subscriptions"
SET "billing_interval" = CASE
  WHEN "current_period_start" IS NOT NULL
    AND "current_period_end" IS NOT NULL
    AND "current_period_end" > "current_period_start"
    AND "current_period_end" - "current_period_start" BETWEEN INTERVAL '300 days' AND INTERVAL '370 days'
    THEN 'yearly'
  WHEN "current_period_start" IS NOT NULL
    AND "current_period_end" IS NOT NULL
    AND "current_period_end" > "current_period_start"
    AND "current_period_end" - "current_period_start" BETWEEN INTERVAL '20 days' AND INTERVAL '45 days'
    THEN 'monthly'
  ELSE 'unknown'
END;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_interval_check"
  CHECK ("subscriptions"."billing_interval" in ('monthly', 'yearly', 'unknown'));

ALTER TABLE "billing_accounts" ADD COLUMN "cycle_anchor_at" timestamp with time zone;
ALTER TABLE "billing_accounts" ADD COLUMN "cycle_source" text DEFAULT 'free_account' NOT NULL;

UPDATE "billing_accounts"
SET "cycle_anchor_at" = "cycle_start_at"
WHERE "cycle_anchor_at" IS NULL;

UPDATE "billing_accounts"
SET
  "cycle_anchor_at" = "subscriptions"."current_period_start",
  "cycle_source" = 'provider_subscription',
  "cycle_start_at" = CASE
    WHEN "subscriptions"."billing_interval" in ('monthly', 'yearly')
      THEN "subscriptions"."current_period_start"
    ELSE "billing_accounts"."cycle_start_at"
  END,
  "cycle_end_at" = CASE
    WHEN "subscriptions"."billing_interval" = 'monthly'
      AND "subscriptions"."current_period_end" IS NOT NULL
      THEN "subscriptions"."current_period_end"
    WHEN "subscriptions"."billing_interval" = 'yearly'
      AND "subscriptions"."current_period_end" IS NOT NULL
      THEN LEAST(
        "subscriptions"."current_period_end",
        "subscriptions"."current_period_start" + INTERVAL '1 month'
      )
    ELSE "billing_accounts"."cycle_end_at"
  END
FROM "subscriptions"
WHERE "subscriptions"."team_id" = "billing_accounts"."team_id"
  AND "subscriptions"."status" in ('trialing', 'active', 'past_due')
  AND "subscriptions"."current_period_start" IS NOT NULL;

ALTER TABLE "billing_accounts" ALTER COLUMN "cycle_anchor_at" SET NOT NULL;

ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_cycle_source_check"
  CHECK ("billing_accounts"."cycle_source" in ('free_account', 'provider_subscription', 'manual'));

ALTER TABLE "billing_accounts" DROP CONSTRAINT IF EXISTS "billing_accounts_cycle_anchor_day_check";
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "cycle_anchor_day";

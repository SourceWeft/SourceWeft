ALTER TABLE "billing_accounts" ADD COLUMN "monthly_pages_grant" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "monthly_pages_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "add_on_pages_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "pages_consumed_this_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH "page_wallet_backfill" AS (
  SELECT
    "team_id",
    CASE "plan_family"
      WHEN 'individual_free' THEN 300
      WHEN 'individual_pro' THEN 6000
      WHEN 'team_standard' THEN 6000 * greatest(2, "seat_count")
      WHEN 'team_premium' THEN 100000
      WHEN 'enterprise_usage' THEN 0
      ELSE "pages_limit"
    END AS "monthly_pages_grant",
    greatest("pages_limit" - "pages_used", 0) AS "previous_pages_remaining"
  FROM "billing_accounts"
)
UPDATE "billing_accounts"
SET
  "monthly_pages_grant" = "page_wallet_backfill"."monthly_pages_grant",
  "pages_limit" = "page_wallet_backfill"."monthly_pages_grant",
  "monthly_pages_balance" = least(
    "page_wallet_backfill"."previous_pages_remaining",
    greatest(
      "page_wallet_backfill"."monthly_pages_grant" - "billing_accounts"."pages_used",
      0
    )
  ),
  "add_on_pages_balance" = greatest(
    "page_wallet_backfill"."previous_pages_remaining" - least(
      "page_wallet_backfill"."previous_pages_remaining",
      greatest(
        "page_wallet_backfill"."monthly_pages_grant" - "billing_accounts"."pages_used",
        0
      )
    ),
    0
  ),
  "pages_consumed_this_cycle" = "billing_accounts"."pages_used"
FROM "page_wallet_backfill"
WHERE "billing_accounts"."team_id" = "page_wallet_backfill"."team_id";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_monthly_pages_grant_check" CHECK ("billing_accounts"."monthly_pages_grant" >= 0);--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_monthly_pages_balance_check" CHECK ("billing_accounts"."monthly_pages_balance" >= 0);--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_add_on_pages_balance_check" CHECK ("billing_accounts"."add_on_pages_balance" >= 0);--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_pages_consumed_check" CHECK ("billing_accounts"."pages_consumed_this_cycle" >= 0);

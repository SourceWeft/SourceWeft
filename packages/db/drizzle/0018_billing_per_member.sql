-- Re-key billing_accounts from a single team row to one row per (team_id, user_id):
-- credits and pages are now granted per-member and a member's runs deduct from
-- their own row (谁问谁付), with no shared team pool. There is no production
-- data yet, so existing rows are cleared and regenerated per-member on first
-- access with fresh grants rather than backfilled.
DELETE FROM "billing_accounts";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP CONSTRAINT "billing_accounts_pkey";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_team_id_user_id_pk" PRIMARY KEY("team_id","user_id");

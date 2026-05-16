ALTER TABLE "usage_ledgers" DROP CONSTRAINT "usage_ledgers_unit_type_check";--> statement-breakpoint
ALTER TABLE "source_connectors" DROP CONSTRAINT "source_connectors_oauth_account_workspace_team_fk";--> statement-breakpoint
DROP INDEX "connector_oauth_accounts_id_workspace_team_uq";--> statement-breakpoint
DROP INDEX "source_connectors_oauth_account_idx";--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD COLUMN "operation_type" text;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD COLUMN "activity_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD COLUMN "activity_title" text;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD COLUMN "activity_summary" text;--> statement-breakpoint
CREATE INDEX "usage_ledgers_team_activity_created_idx" ON "usage_ledgers" USING btree ("team_id","created_at" desc) WHERE "usage_ledgers"."activity_visible" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledgers_team_operation_visible_uq" ON "usage_ledgers" USING btree ("team_id","operation_id") WHERE "usage_ledgers"."activity_visible" = true and "usage_ledgers"."operation_id" is not null;--> statement-breakpoint
ALTER TABLE "connector_oauth_accounts" ADD CONSTRAINT "connector_oauth_accounts_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id");--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_oauth_account_workspace_team_fk" FOREIGN KEY ("oauth_account_id","workspace_id","team_id") REFERENCES "public"."connector_oauth_accounts"("id","workspace_id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_operation_type_check" CHECK ("usage_ledgers"."operation_type" is null or "usage_ledgers"."operation_type" in ('seat_change', 'cycle_renewal', 'plan_change', 'topup', 'usage', 'quota_adjustment'));--> statement-breakpoint
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_unit_type_check" CHECK ("usage_ledgers"."unit_type" in ('credit', 'page', 'seat'));

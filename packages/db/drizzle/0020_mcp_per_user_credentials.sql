DROP INDEX "workspace_mcp_credentials_install_uq";--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "user_id" text;--> statement-breakpoint
-- Static MCP credentials become per-user. Existing shared rows are attributed
-- to whoever configured them; a row with no recorded configurer can't be
-- attributed and is dropped (the owner re-enters it, now scoped to them).
UPDATE "workspace_mcp_credentials" SET "user_id" = "configured_by" WHERE "user_id" IS NULL;--> statement-breakpoint
DELETE FROM "workspace_mcp_credentials" WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_credentials_install_user_uq" ON "workspace_mcp_credentials" USING btree ("install_id","user_id");

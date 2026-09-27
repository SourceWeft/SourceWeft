-- The MCP catalog tables came from the retired sourceweft-api as a generic
-- `market_*` catalog, but they only ever held MCP servers (skills live in
-- `skill_*`). Rename them to `mcp_*` in place so existing rows are kept, and
-- drop what the generic design left behind: `kind` (always 'mcp') and the
-- never-written package columns.
--
-- Stop rather than silently turn a non-MCP row into a listed MCP server once
-- `kind` is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "market_items" WHERE "kind" <> 'mcp') THEN
    RAISE EXCEPTION 'market_items holds rows whose kind is not mcp; resolve them before renaming the MCP catalog';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "market_items" RENAME TO "mcp_servers";--> statement-breakpoint
ALTER TABLE "market_item_versions" RENAME TO "mcp_server_versions";--> statement-breakpoint
ALTER TABLE "market_categories" RENAME TO "mcp_categories";--> statement-breakpoint
ALTER TABLE "market_item_categories" RENAME TO "mcp_server_categories";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" RENAME COLUMN "item_id" TO "server_id";--> statement-breakpoint
ALTER TABLE "mcp_server_categories" RENAME COLUMN "item_id" TO "server_id";--> statement-breakpoint
ALTER TABLE "mcp_servers" RENAME CONSTRAINT "market_items_pkey" TO "mcp_servers_pkey";--> statement-breakpoint
ALTER TABLE "mcp_servers" RENAME CONSTRAINT "market_items_status_check" TO "mcp_servers_status_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" RENAME CONSTRAINT "market_items_visibility_check" TO "mcp_servers_visibility_check";--> statement-breakpoint
ALTER INDEX "market_items_identifier_uq" RENAME TO "mcp_servers_identifier_uq";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" RENAME CONSTRAINT "market_item_versions_pkey" TO "mcp_server_versions_pkey";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" RENAME CONSTRAINT "market_item_versions_status_check" TO "mcp_server_versions_status_check";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" RENAME CONSTRAINT "market_item_versions_origin_check" TO "mcp_server_versions_origin_check";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" RENAME CONSTRAINT "market_item_versions_item_id_market_items_id_fk" TO "mcp_server_versions_server_id_mcp_servers_id_fk";--> statement-breakpoint
ALTER INDEX "market_item_versions_item_version_uq" RENAME TO "mcp_server_versions_server_version_uq";--> statement-breakpoint
ALTER INDEX "market_item_versions_item_status_idx" RENAME TO "mcp_server_versions_server_status_idx";--> statement-breakpoint
ALTER TABLE "mcp_categories" RENAME CONSTRAINT "market_categories_pkey" TO "mcp_categories_pkey";--> statement-breakpoint
ALTER TABLE "mcp_categories" RENAME CONSTRAINT "market_categories_slug_unique" TO "mcp_categories_slug_unique";--> statement-breakpoint
ALTER TABLE "mcp_server_categories" RENAME CONSTRAINT "market_item_categories_pk" TO "mcp_server_categories_pk";--> statement-breakpoint
ALTER TABLE "mcp_server_categories" RENAME CONSTRAINT "market_item_categories_item_id_market_items_id_fk" TO "mcp_server_categories_server_id_mcp_servers_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_server_categories" RENAME CONSTRAINT "market_item_categories_category_id_market_categories_id_fk" TO "mcp_server_categories_category_id_mcp_categories_id_fk";--> statement-breakpoint
DROP INDEX "market_items_kind_status_visibility_idx";--> statement-breakpoint
DROP INDEX "market_items_browse_idx";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "market_items_kind_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "kind";--> statement-breakpoint
CREATE INDEX "mcp_servers_browse_idx" ON "mcp_servers" USING btree ("status","visibility","published_at" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "mcp_server_versions" DROP COLUMN "package_object_key";--> statement-breakpoint
ALTER TABLE "mcp_server_versions" DROP COLUMN "package_sha256";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "categories_set_by" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_categories_set_by_check" CHECK ("mcp_servers"."categories_set_by" in ('auto', 'ai', 'admin'));

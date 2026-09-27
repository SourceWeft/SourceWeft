-- README storage and fetch state for MCP server versions. Every existing
-- version starts `pending` and due now: `readme_next_fetch_at` takes its
-- `now()` default as the column is added, so the README fetch job works
-- through the catalog on its first runs. New versions are due at once the
-- same way.
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_path" text;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_ref" text;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_sha256" text;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_etag" text;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_next_fetch_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_error" text;--> statement-breakpoint
CREATE INDEX "mcp_server_versions_readme_due_idx" ON "mcp_server_versions" USING btree ("readme_next_fetch_at");--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD CONSTRAINT "mcp_server_versions_readme_status_check" CHECK ("mcp_server_versions"."readme_status" in ('pending', 'ok', 'not_found', 'too_large', 'unsupported_host', 'error'));
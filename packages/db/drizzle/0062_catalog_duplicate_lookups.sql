-- Lookups for duplicate catalog pages: skills whose current versions carry the
-- same files, and MCP servers whose shown version carries the same README.
-- Not CONCURRENTLY: migrations run in one transaction. Each build blocks
-- writes to its table while it runs, which is brief at the catalog's size.
CREATE INDEX "skill_versions_current_content_hash_idx" ON "skill_versions" USING btree ("content_hash") WHERE "skill_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "mcp_server_versions_readme_sha256_idx" ON "mcp_server_versions" USING btree ("readme_sha256") WHERE "mcp_server_versions"."readme_status" = 'ok';

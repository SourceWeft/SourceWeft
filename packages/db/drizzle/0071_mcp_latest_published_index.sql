-- The latest published version of a server (modules/market/latest-version.ts)
-- is looked up once per candidate row by the README, overview, summary
-- translation and stdio schedulers. This partial index serves it in the same
-- order, so each lookup is one index probe instead of a sort over every
-- published version of the server. Additive and cheap to build (about 108k
-- rows), so it is safe against the previous release's code.
CREATE INDEX "mcp_server_versions_latest_published_idx" ON "mcp_server_versions" USING btree ("server_id","published_at" desc,"created_at" desc) WHERE "mcp_server_versions"."status" = 'published';
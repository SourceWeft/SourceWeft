-- The README fetch now reads the default branch through batched GitHub GraphQL
-- requests, which carry no ETag, so the stored ETag is retired. Nothing else
-- changes: every README stays as it is until its next read.
ALTER TABLE "mcp_server_versions" DROP COLUMN "readme_etag";

-- The README hash the AI overview's input fingerprint uses when it is not the
-- stored file's (Issue #454): a refresh that reads new bytes whose overview
-- excerpt is unchanged keeps the previous hash here, so the overview is not
-- regenerated. Null means "use readme_sha256", so existing rows keep their
-- fingerprints. Additive and nullable: safe against the previous release.
ALTER TABLE "mcp_server_versions" ADD COLUMN "readme_overview_sha256" text;
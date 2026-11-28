-- One statement, so the table is rewritten once.
ALTER TABLE "skill_versions"
  ADD COLUMN "scan_flags" jsonb GENERATED ALWAYS AS (coalesce("manifest_json"->'registry'->'scan'->'flags', '[]'::jsonb)) STORED,
  ADD COLUMN "script_paths" jsonb GENERATED ALWAYS AS (jsonb_path_query_array("manifest_json", '$.registry.fileManifest[*] ? (@.role == "script").path')) STORED,
  ADD COLUMN "listing_acknowledged" boolean GENERATED ALWAYS AS ("manifest_json"->'market'->>'acknowledgedAt' is not null) STORED;

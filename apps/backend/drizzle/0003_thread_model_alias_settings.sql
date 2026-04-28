UPDATE "threads"
SET "model_settings_json" = jsonb_strip_nulls(
  "model_settings_json" - 'llmProfileAlias' - 'imageProfileAlias' - 'visionProfileAlias' || jsonb_build_object(
    'llmModelAlias', COALESCE(
      "model_settings_json"->>'llmModelAlias',
      (
        SELECT "model_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'chat'
          AND "profile_alias" = "threads"."model_settings_json"->>'llmProfileAlias'
        LIMIT 1
      ),
      "model_settings_json"->>'llmProfileAlias'
    ),
    'imageModelAlias', COALESCE(
      "model_settings_json"->>'imageModelAlias',
      (
        SELECT "model_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'image'
          AND "profile_alias" = "threads"."model_settings_json"->>'imageProfileAlias'
        LIMIT 1
      ),
      "model_settings_json"->>'imageProfileAlias'
    ),
    'visionModelAlias', COALESCE(
      "model_settings_json"->>'visionModelAlias',
      (
        SELECT "model_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'vision'
          AND "profile_alias" = "threads"."model_settings_json"->>'visionProfileAlias'
        LIMIT 1
      ),
      "model_settings_json"->>'visionProfileAlias'
    )
  )
)
WHERE "model_settings_json" ? 'llmProfileAlias'
   OR "model_settings_json" ? 'imageProfileAlias'
   OR "model_settings_json" ? 'visionProfileAlias';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "model_gateway_profiles"
    WHERE "is_active" = true
    GROUP BY "kind", "model_alias"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active model_gateway_profiles(kind, model_alias) rows must be resolved before creating unique index';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_gateway_profiles_active_kind_model_alias_uq"
ON "model_gateway_profiles" USING btree ("kind", "model_alias")
WHERE "model_gateway_profiles"."is_active" = true;

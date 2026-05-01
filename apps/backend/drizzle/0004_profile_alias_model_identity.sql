UPDATE "threads"
SET "model_settings_json" = jsonb_strip_nulls(
  "model_settings_json" || jsonb_build_object(
    'llmProfileAlias', COALESCE(
      "model_settings_json"->>'llmProfileAlias',
      (
        SELECT "profile_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'chat'
          AND "model_alias" = "threads"."model_settings_json"->>'llmModelAlias'
          AND "is_active" = true
        ORDER BY "is_default" DESC, "updated_at" DESC
        LIMIT 1
      ),
      "model_settings_json"->>'llmModelAlias'
    ),
    'imageProfileAlias', COALESCE(
      "model_settings_json"->>'imageProfileAlias',
      (
        SELECT "profile_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'image'
          AND "model_alias" = "threads"."model_settings_json"->>'imageModelAlias'
          AND "is_active" = true
        ORDER BY "is_default" DESC, "updated_at" DESC
        LIMIT 1
      ),
      "model_settings_json"->>'imageModelAlias'
    ),
    'visionProfileAlias', COALESCE(
      "model_settings_json"->>'visionProfileAlias',
      (
        SELECT "profile_alias"
        FROM "model_gateway_profiles"
        WHERE "kind" = 'vision'
          AND "model_alias" = "threads"."model_settings_json"->>'visionModelAlias'
          AND "is_active" = true
        ORDER BY "is_default" DESC, "updated_at" DESC
        LIMIT 1
      ),
      "model_settings_json"->>'visionModelAlias'
    )
  )
)
WHERE "model_settings_json" ? 'llmModelAlias'
   OR "model_settings_json" ? 'imageModelAlias'
   OR "model_settings_json" ? 'visionModelAlias';--> statement-breakpoint
DROP INDEX IF EXISTS "model_gateway_profiles_active_kind_model_alias_uq";

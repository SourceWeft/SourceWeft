CREATE TABLE "model_gateway_byok_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"provider_name" text NOT NULL,
	"provider_kind" text DEFAULT 'openai-compatible' NOT NULL,
	"base_url" text,
	"credential_alias" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"default_headers_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_byok_credentials_kind_check" CHECK ("model_gateway_byok_credentials"."provider_kind" in ('openai-compatible', 'openrouter', 'deepinfra', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai'))
);
--> statement-breakpoint
CREATE TABLE "model_gateway_byok_models" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"provider_name" text NOT NULL,
	"model_name" text NOT NULL,
	"display_name" text NOT NULL,
	"model_type" text NOT NULL,
	"capabilities_json" jsonb,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_byok_models_type_check" CHECK ("model_gateway_byok_models"."model_type" in ('llm', 'image', 'vision'))
);
--> statement-breakpoint
ALTER TABLE "model_gateway_byok_credentials" ADD CONSTRAINT "model_gateway_byok_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_gateway_byok_credentials" ADD CONSTRAINT "model_gateway_byok_credentials_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_credential_id_model_gateway_byok_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."model_gateway_byok_credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_gateway_byok_models" ADD CONSTRAINT "model_gateway_byok_models_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_gateway_byok_credentials_lookup_idx" ON "model_gateway_byok_credentials" USING btree ("team_id","workspace_id","user_id","provider_name","is_active");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_byok_credentials_alias_uq" ON "model_gateway_byok_credentials" USING btree ("workspace_id","user_id","provider_name","credential_alias");
--> statement-breakpoint
CREATE INDEX "model_gateway_byok_models_credential_idx" ON "model_gateway_byok_models" USING btree ("credential_id","is_active");
--> statement-breakpoint
CREATE INDEX "model_gateway_byok_models_lookup_idx" ON "model_gateway_byok_models" USING btree ("team_id","workspace_id","user_id","provider_name","model_type","is_active");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_byok_models_credential_model_uq" ON "model_gateway_byok_models" USING btree ("workspace_id","user_id","credential_id","model_name","model_type");
--> statement-breakpoint
INSERT INTO "model_gateway_byok_credentials" (
	"id",
	"team_id",
	"workspace_id",
	"user_id",
	"provider_name",
	"provider_kind",
	"base_url",
	"credential_alias",
	"api_key_encrypted",
	"default_headers_json",
	"is_active",
	"metadata_json",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"team_id",
	"workspace_id",
	"user_id",
	"provider_name",
	COALESCE("provider_kind", 'openai-compatible'),
	"base_url",
	"key_ref",
	"api_key_encrypted",
	COALESCE("default_headers", '{}'::jsonb),
	"is_active",
	jsonb_build_object('legacyKeyRef', "key_ref"),
	"created_at",
	"updated_at"
FROM "model_gateway_byok_key_refs"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "model_gateway_byok_models" (
	"id",
	"credential_id",
	"team_id",
	"workspace_id",
	"user_id",
	"provider_name",
	"model_name",
	"display_name",
	"model_type",
	"capabilities_json",
	"config_json",
	"is_active",
	"created_at",
	"updated_at"
)
SELECT
	('legacy-byok-model:' || key_ref_row."id" || ':' || md5(model_item::text)),
	key_ref_row."id",
	key_ref_row."team_id",
	key_ref_row."workspace_id",
	key_ref_row."user_id",
	key_ref_row."provider_name",
	model_item->>'modelName',
	COALESCE(NULLIF(model_item->>'displayName', ''), model_item->>'modelName'),
	model_item->>'modelType',
	CASE
		WHEN jsonb_typeof(model_item->'capabilities') = 'object' THEN model_item->'capabilities'
		ELSE NULL
	END,
	'{}'::jsonb,
	key_ref_row."is_active",
	key_ref_row."created_at",
	key_ref_row."updated_at"
FROM "model_gateway_byok_key_refs" key_ref_row
CROSS JOIN LATERAL (
	SELECT model_item
	FROM jsonb_array_elements(
		CASE
			WHEN jsonb_typeof(key_ref_row."metadata_json"->'models') = 'array' THEN key_ref_row."metadata_json"->'models'
			ELSE '[]'::jsonb
		END
	) model_item
) legacy_model_items(model_item)
WHERE
	model_item->>'modelName' IS NOT NULL
	AND model_item->>'modelName' <> ''
	AND model_item->>'modelType' in ('llm', 'image', 'vision')
ON CONFLICT DO NOTHING;

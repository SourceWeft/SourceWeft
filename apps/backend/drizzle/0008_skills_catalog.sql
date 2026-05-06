CREATE TABLE "skill_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"workspace_id" text,
	"source_type" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"visibility" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_definitions_source_type_check" CHECK ("skill_definitions"."source_type" in ('builtin', 'workspace_custom', 'team_custom')),
	CONSTRAINT "skill_definitions_visibility_check" CHECK ("skill_definitions"."visibility" in ('public', 'restricted', 'workspace', 'team')),
	CONSTRAINT "skill_definitions_status_check" CHECK ("skill_definitions"."status" in ('active', 'archived')),
	CONSTRAINT "skill_definitions_scope_check" CHECK (("skill_definitions"."source_type" = 'builtin' and "skill_definitions"."team_id" is null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" in ('public', 'restricted')) or ("skill_definitions"."source_type" = 'workspace_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is not null and "skill_definitions"."visibility" = 'workspace') or ("skill_definitions"."source_type" = 'team_custom' and "skill_definitions"."team_id" is not null and "skill_definitions"."workspace_id" is null and "skill_definitions"."visibility" = 'team'))
);
--> statement-breakpoint
CREATE TABLE "skill_entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"team_id" text,
	"workspace_id" text,
	"expires_at" timestamp with time zone,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_entitlements_scope_check" CHECK ("skill_entitlements"."team_id" is not null or "skill_entitlements"."workspace_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "skill_version_files" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_version_id" text NOT NULL,
	"path" text NOT NULL,
	"content_text" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_files_size_check" CHECK ("skill_version_files"."size_bytes" >= 0),
	CONSTRAINT "skill_version_files_relative_path_check" CHECK ("skill_version_files"."path" <> '' and "skill_version_files"."path" not like '/%' and "skill_version_files"."path" not like '../%' and "skill_version_files"."path" not like '%/../%')
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"storage_type" text NOT NULL,
	"storage_pointer" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"content_hash" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_status_check" CHECK ("skill_versions"."status" in ('draft', 'published', 'deprecated', 'disabled')),
	CONSTRAINT "skill_versions_storage_type_check" CHECK ("skill_versions"."storage_type" in ('repo_builtin', 'db_text'))
);
--> statement-breakpoint
CREATE TABLE "workspace_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_by" text,
	"enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD CONSTRAINT "skill_definitions_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_id_skill_definitions_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_slug_uq" ON "skill_definitions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skill_definitions_team_workspace_status_idx" ON "skill_definitions" USING btree ("team_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "skill_entitlements_skill_idx" ON "skill_entitlements" USING btree ("skill_id","team_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_version_files_version_path_uq" ON "skill_version_files" USING btree ("skill_version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uq" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_current_uq" ON "skill_versions" USING btree ("skill_id") WHERE "skill_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "skill_versions_skill_status_idx" ON "skill_versions" USING btree ("skill_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_skills_skill_uq" ON "workspace_skills" USING btree ("workspace_id","skill_id");--> statement-breakpoint
CREATE INDEX "workspace_skills_workspace_enabled_idx" ON "workspace_skills" USING btree ("team_id","workspace_id","enabled");
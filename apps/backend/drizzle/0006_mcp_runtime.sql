CREATE TABLE IF NOT EXISTS "workspace_mcp_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text DEFAULT 'market' NOT NULL,
	"market_identifier" text,
	"market_version" text,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"transport" text NOT NULL,
	"endpoint_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"desktop_only" boolean DEFAULT false NOT NULL,
	"web_executable" boolean DEFAULT true NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"credential_status" text DEFAULT 'not_required' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text,
	"signing_key_id" text,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_mcp_installs_id_workspace_team_uq" UNIQUE("id","workspace_id","team_id"),
	CONSTRAINT "workspace_mcp_installs_source_check" CHECK ("workspace_mcp_installs"."source" in ('market', 'custom', 'local_import')),
	CONSTRAINT "workspace_mcp_installs_transport_check" CHECK ("workspace_mcp_installs"."transport" in ('streamable_http', 'http_sse_compat', 'sse', 'stdio')),
	CONSTRAINT "workspace_mcp_installs_status_check" CHECK ("workspace_mcp_installs"."status" in ('active', 'disabled', 'error')),
	CONSTRAINT "workspace_mcp_installs_auth_type_check" CHECK ("workspace_mcp_installs"."auth_type" in ('none', 'bearer', 'api_key_header', 'custom_headers')),
	CONSTRAINT "workspace_mcp_installs_credential_status_check" CHECK ("workspace_mcp_installs"."credential_status" in ('not_required', 'required', 'configured', 'invalid'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_installs" ADD CONSTRAINT "workspace_mcp_installs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_installs" ADD CONSTRAINT "workspace_mcp_installs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mcp_installs_market_uq" ON "workspace_mcp_installs" USING btree ("workspace_id","market_identifier") WHERE "workspace_mcp_installs"."market_identifier" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_mcp_installs_workspace_status_idx" ON "workspace_mcp_installs" USING btree ("team_id","workspace_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_mcp_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"install_id" text NOT NULL,
	"server_tool_name" text NOT NULL,
	"normalized_tool_name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text DEFAULT 'unknown' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_discovered_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_mcp_tools_risk_check" CHECK ("workspace_mcp_tools"."risk" in ('read', 'write', 'destructive', 'unknown'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_tools" ADD CONSTRAINT "workspace_mcp_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_tools" ADD CONSTRAINT "workspace_mcp_tools_install_id_workspace_mcp_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."workspace_mcp_installs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_tools" ADD CONSTRAINT "workspace_mcp_tools_install_workspace_team_fk" FOREIGN KEY ("install_id","workspace_id","team_id") REFERENCES "public"."workspace_mcp_installs"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mcp_tools_install_tool_uq" ON "workspace_mcp_tools" USING btree ("install_id","server_tool_name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mcp_tools_workspace_normalized_uq" ON "workspace_mcp_tools" USING btree ("workspace_id","normalized_tool_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_mcp_tools_install_enabled_idx" ON "workspace_mcp_tools" USING btree ("install_id","enabled");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_mcp_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"install_id" text NOT NULL,
	"auth_type" text NOT NULL,
	"encrypted_secret" text,
	"encrypted_headers" text,
	"header_name" text,
	"status" text DEFAULT 'configured' NOT NULL,
	"configured_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_mcp_credentials_auth_type_check" CHECK ("workspace_mcp_credentials"."auth_type" in ('none', 'bearer', 'api_key_header', 'custom_headers')),
	CONSTRAINT "workspace_mcp_credentials_status_check" CHECK ("workspace_mcp_credentials"."status" in ('not_required', 'required', 'configured', 'invalid'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_install_id_workspace_mcp_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."workspace_mcp_installs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_install_workspace_team_fk" FOREIGN KEY ("install_id","workspace_id","team_id") REFERENCES "public"."workspace_mcp_installs"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_mcp_credentials_install_uq" ON "workspace_mcp_credentials" USING btree ("install_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tool_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"tool_call_id" text,
	"install_id" text,
	"tool_id" text,
	"action_run_id" text,
	"server_tool_name" text NOT NULL,
	"normalized_tool_name" text NOT NULL,
	"risk" text DEFAULT 'unknown' NOT NULL,
	"status" text NOT NULL,
	"redacted_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redacted_output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_runs_risk_check" CHECK ("mcp_tool_runs"."risk" in ('read', 'write', 'destructive', 'unknown')),
	CONSTRAINT "mcp_tool_runs_status_check" CHECK ("mcp_tool_runs"."status" in ('running', 'succeeded', 'failed', 'proposed', 'rejected', 'canceled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tool_runs" ADD CONSTRAINT "mcp_tool_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tool_runs" ADD CONSTRAINT "mcp_tool_runs_install_id_workspace_mcp_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."workspace_mcp_installs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tool_runs" ADD CONSTRAINT "mcp_tool_runs_tool_id_workspace_mcp_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."workspace_mcp_tools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tool_runs" ADD CONSTRAINT "mcp_tool_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_runs_workspace_created_idx" ON "mcp_tool_runs" USING btree ("workspace_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_runs_install_created_idx" ON "mcp_tool_runs" USING btree ("install_id","created_at" desc);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_action_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"install_id" text NOT NULL,
	"tool_id" text,
	"server_tool_name" text NOT NULL,
	"normalized_tool_name" text NOT NULL,
	"risk" text DEFAULT 'unknown' NOT NULL,
	"status" text NOT NULL,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_preview" text DEFAULT '' NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text,
	"executed_by" text,
	"idempotency_key" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_action_runs_risk_check" CHECK ("mcp_action_runs"."risk" in ('read', 'write', 'destructive', 'unknown')),
	CONSTRAINT "mcp_action_runs_status_check" CHECK ("mcp_action_runs"."status" in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_action_runs" ADD CONSTRAINT "mcp_action_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_action_runs" ADD CONSTRAINT "mcp_action_runs_install_id_workspace_mcp_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."workspace_mcp_installs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_action_runs" ADD CONSTRAINT "mcp_action_runs_tool_id_workspace_mcp_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."workspace_mcp_tools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_action_runs" ADD CONSTRAINT "mcp_action_runs_install_workspace_team_fk" FOREIGN KEY ("install_id","workspace_id","team_id") REFERENCES "public"."workspace_mcp_installs"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_action_runs_idempotency_uq" ON "mcp_action_runs" USING btree ("workspace_id","install_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_action_runs_workspace_status_created_idx" ON "mcp_action_runs" USING btree ("workspace_id","status","created_at" desc);

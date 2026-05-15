CREATE TABLE "connector_oauth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"provider_account_id" text,
	"provider_account_email" text,
	"display_name" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_refresh_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_oauth_accounts_status_check" CHECK ("connector_oauth_accounts"."status" in ('active', 'reauth_required', 'revoked', 'disabled')),
	CONSTRAINT "connector_oauth_accounts_scopes_array_check" CHECK (jsonb_typeof("connector_oauth_accounts"."scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"redirect_after" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_action_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"action_type" text NOT NULL,
	"risk_level" text NOT NULL,
	"status" text NOT NULL,
	"request_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_preview" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_id" text,
	"idempotency_key" text NOT NULL,
	"approved_by" text,
	"executed_by" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_action_runs_risk_level_check" CHECK ("connector_action_runs"."risk_level" in ('low', 'medium', 'high')),
	CONSTRAINT "connector_action_runs_status_check" CHECK ("connector_action_runs"."status" in ('proposed', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "source_connectors" ADD COLUMN "oauth_account_id" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "sources_workspace_content_hash_uq";
--> statement-breakpoint
ALTER TABLE "connector_oauth_accounts" ADD CONSTRAINT "connector_oauth_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_oauth_accounts" ADD CONSTRAINT "connector_oauth_accounts_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_oauth_account_id_connector_oauth_accounts_id_fk" FOREIGN KEY ("oauth_account_id") REFERENCES "public"."connector_oauth_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_accounts_id_workspace_team_uq" ON "connector_oauth_accounts" USING btree ("id","workspace_id","team_id");
--> statement-breakpoint
ALTER TABLE "source_connectors" ADD CONSTRAINT "source_connectors_oauth_account_workspace_team_fk" FOREIGN KEY ("oauth_account_id","workspace_id","team_id") REFERENCES "public"."connector_oauth_accounts"("id","workspace_id","team_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_action_runs" ADD CONSTRAINT "connector_action_runs_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "connector_oauth_accounts_workspace_type_status_idx" ON "connector_oauth_accounts" USING btree ("workspace_id","connector_type","status");
--> statement-breakpoint
CREATE INDEX "connector_oauth_accounts_team_workspace_created_idx" ON "connector_oauth_accounts" USING btree ("team_id","workspace_id","created_at" desc);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_states_state_hash_uq" ON "connector_oauth_states" USING btree ("state_hash");
--> statement-breakpoint
CREATE INDEX "connector_oauth_states_workspace_user_created_idx" ON "connector_oauth_states" USING btree ("workspace_id","user_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX "connector_oauth_states_expires_idx" ON "connector_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "source_connectors_oauth_account_idx" ON "source_connectors" USING btree ("oauth_account_id");
--> statement-breakpoint
CREATE INDEX "connector_action_runs_connector_created_idx" ON "connector_action_runs" USING btree ("connector_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX "connector_action_runs_workspace_status_created_idx" ON "connector_action_runs" USING btree ("workspace_id","status","created_at" desc);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_action_runs_idempotency_uq" ON "connector_action_runs" USING btree ("workspace_id","connector_id","idempotency_key");

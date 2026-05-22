ALTER TABLE "connector_action_runs" ADD COLUMN IF NOT EXISTS "agent_tool_name" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tool_trust_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"tool_name" text NOT NULL,
	"connector_id" text,
	"target_type" text,
	"target_id" text,
	"allowed_risk_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_from_confirmation_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_trust_rules_status_check" CHECK ("agent_tool_trust_rules"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_trust_rules" ADD CONSTRAINT "agent_tool_trust_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_trust_rules" ADD CONSTRAINT "agent_tool_trust_rules_connector_id_source_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_trust_rules" ADD CONSTRAINT "agent_tool_trust_rules_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tool_trust_rules" ADD CONSTRAINT "agent_tool_trust_rules_connector_workspace_team_fk" FOREIGN KEY ("connector_id","workspace_id","team_id") REFERENCES "public"."source_connectors"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_trust_rules_scope_idx" ON "agent_tool_trust_rules" USING btree ("workspace_id","user_id","domain","tool_name","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_trust_rules_connector_idx" ON "agent_tool_trust_rules" USING btree ("connector_id");

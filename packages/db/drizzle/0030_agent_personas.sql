CREATE TABLE "agent_personas" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"system_prompt" text NOT NULL,
	"avatar" text,
	"model_settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_allowlist_json" jsonb,
	"filesystem_policy" text DEFAULT 'default' NOT NULL,
	"cloned_from" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_personas_workspace_slug_uq" UNIQUE("workspace_id","slug"),
	CONSTRAINT "agent_personas_filesystem_policy_check" CHECK ("agent_personas"."filesystem_policy" in ('default', 'read_only'))
);
--> statement-breakpoint
ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_personas_workspace_created_idx" ON "agent_personas" USING btree ("workspace_id","created_at" desc);
-- Sub-agent threads and workspace personas. Written idempotently: this schema
-- shipped earlier as 0029/0030 on a feature branch and was renumbered when the
-- branch merged, so databases that already applied those files converge here.
CREATE TABLE IF NOT EXISTS "agent_personas" (
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
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "parent_thread_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "persona_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_personas_workspace_id_workspaces_id_fk') THEN
		ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_personas_workspace_team_fk') THEN
		ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_personas_workspace_created_idx" ON "agent_personas" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threads_parent_thread_id_threads_id_fk') THEN
		ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_workspace_parent_idx" ON "threads" USING btree ("workspace_id","parent_thread_id");--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threads_origin_check') THEN
		ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_check" CHECK ("threads"."origin" in ('user', 'subagent'));
	END IF;
END $$;

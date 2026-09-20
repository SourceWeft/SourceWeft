CREATE TABLE "skill_registry_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"submitted_by" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_input" text NOT NULL,
	"repo_owner" text,
	"repo_name" text,
	"ref" text,
	"subpath" text,
	"commit_sha" text,
	"commit_committed_at" timestamp with time zone,
	"target" text DEFAULT 'workspace' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_complete" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "skill_registry_submissions_source_kind_check" CHECK ("skill_registry_submissions"."source_kind" in ('github', 'upload')),
	CONSTRAINT "skill_registry_submissions_target_check" CHECK ("skill_registry_submissions"."target" in ('workspace', 'team')),
	CONSTRAINT "skill_registry_submissions_status_check" CHECK ("skill_registry_submissions"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "skill_registry_submissions" ADD CONSTRAINT "skill_registry_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_registry_submissions_workspace_created_idx" ON "skill_registry_submissions" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "skill_registry_submissions_inflight_uq" ON "skill_registry_submissions" USING btree ("submitted_by","source_kind",lower("source_input")) WHERE "skill_registry_submissions"."status" in ('queued', 'running');
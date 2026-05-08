CREATE TABLE "working_files" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"path" text NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"mime_type" text DEFAULT 'text/plain' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"purpose" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_files_path_check" CHECK ("working_files"."path" ~ '^/work/[^[:cntrl:]]+$' and "working_files"."path" not like '%..%' and "working_files"."path" not like '%~%' and "working_files"."path" not like '%//%'),
	CONSTRAINT "working_files_purpose_check" CHECK ("working_files"."purpose" is null or "working_files"."purpose" in ('scratch', 'draft', 'note', 'output_candidate')),
	CONSTRAINT "working_files_size_bytes_check" CHECK ("working_files"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "working_files_thread_path_uq" ON "working_files" USING btree ("team_id","workspace_id","thread_id","path");
--> statement-breakpoint
CREATE INDEX "working_files_thread_updated_idx" ON "working_files" USING btree ("team_id","workspace_id","thread_id","updated_at" desc);

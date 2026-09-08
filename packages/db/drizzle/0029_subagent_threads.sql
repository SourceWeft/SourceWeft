ALTER TABLE "threads" ADD COLUMN "parent_thread_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_workspace_parent_idx" ON "threads" USING btree ("workspace_id","parent_thread_id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_check" CHECK ("threads"."origin" in ('user', 'subagent'));
CREATE TABLE "source_guides" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content_json" jsonb,
	"error_code" text,
	"trigger" text NOT NULL,
	"payer_user_id" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_guides_status_check" CHECK ("source_guides"."status" in ('pending', 'generating', 'ready', 'failed')),
	CONSTRAINT "source_guides_trigger_check" CHECK ("source_guides"."trigger" in ('auto', 'manual')),
	CONSTRAINT "source_guides_error_code_check" CHECK ("source_guides"."error_code" is null or "source_guides"."error_code" in ('NO_PAYER', 'QUOTA', 'MODEL', 'EMPTY_SOURCE'))
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "source_guides" ADD CONSTRAINT "source_guides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_guides" ADD CONSTRAINT "source_guides_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_guides" ADD CONSTRAINT "source_guides_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_guides_source_uq" ON "source_guides" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_guides_workspace_status_idx" ON "source_guides" USING btree ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_source_message_uq" ON "notes" USING btree ("source_message_id") WHERE "notes"."note_type" = 'saved_response';
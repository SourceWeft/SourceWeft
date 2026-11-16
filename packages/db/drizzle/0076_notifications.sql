CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_kind" text,
	"ref_id" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_count_check" CHECK ("notifications"."occurrence_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "notifications_user_inbox_idx" ON "notifications" USING btree ("user_id","team_id","read_at","last_occurred_at" desc);--> statement-breakpoint
CREATE INDEX "notifications_merge_idx" ON "notifications" USING btree ("user_id","kind","ref_id","created_at" desc);
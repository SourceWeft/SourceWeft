CREATE TABLE "thread_pins" (
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_pins_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "thread_pins" ADD CONSTRAINT "thread_pins_thread_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_pins_user_workspace_idx" ON "thread_pins" USING btree ("user_id","workspace_id","pinned_at" desc);
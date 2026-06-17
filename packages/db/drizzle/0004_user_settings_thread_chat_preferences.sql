CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_settings_object_check" CHECK (jsonb_typeof("settings") = 'object')
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "chat_preferences_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_chat_preferences_object_check" CHECK (jsonb_typeof("chat_preferences_json") = 'object');

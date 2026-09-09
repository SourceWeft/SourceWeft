CREATE TABLE "local_device_enrollments" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"connection_id" text,
	"heartbeat_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_thread_bindings" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"local_workspace_id" text,
	"workspace_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_tool_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_thread_bindings" ADD CONSTRAINT "local_thread_bindings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_thread_bindings" ADD CONSTRAINT "local_thread_bindings_device_id_local_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_tool_invocations" ADD CONSTRAINT "local_tool_invocations_device_id_local_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_tool_invocations" ADD CONSTRAINT "local_tool_invocations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_devices_token_uq" ON "local_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "local_invocations_device_status_idx" ON "local_tool_invocations" USING btree ("device_id","status");
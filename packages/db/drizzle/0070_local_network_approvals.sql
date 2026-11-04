CREATE TABLE "local_network_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"ask_id" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scope" text,
	"reason" text,
	"suggested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "local_network_requests_status_check" CHECK ("local_network_requests"."status" in ('pending', 'allowed', 'denied', 'expired')),
	CONSTRAINT "local_network_requests_scope_check" CHECK ("local_network_requests"."scope" is null or ("local_network_requests"."scope" in ('once', 'always') and "local_network_requests"."status" = 'allowed')),
	CONSTRAINT "local_network_requests_port_check" CHECK ("local_network_requests"."port" between 1 and 65535),
	CONSTRAINT "local_network_requests_resolved_check" CHECK (("local_network_requests"."status" = 'pending') = ("local_network_requests"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "network_mode" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_network_requests" ADD CONSTRAINT "local_network_requests_invocation_id_local_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."local_tool_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_network_requests" ADD CONSTRAINT "local_network_requests_device_id_local_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_network_requests" ADD CONSTRAINT "local_network_requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_network_requests_device_ask_uq" ON "local_network_requests" USING btree ("device_id","ask_id");--> statement-breakpoint
CREATE INDEX "local_network_requests_thread_status_idx" ON "local_network_requests" USING btree ("thread_id","status");--> statement-breakpoint
CREATE INDEX "local_network_requests_device_delivered_idx" ON "local_network_requests" USING btree ("device_id","delivered_at");--> statement-breakpoint
ALTER TABLE "local_devices" ADD CONSTRAINT "local_devices_network_mode_check" CHECK ("local_devices"."network_mode" in ('open', 'ask', 'strict'));
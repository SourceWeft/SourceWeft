ALTER TABLE "workspace_mcp_oauth_sessions" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD COLUMN "pending_return_to" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD COLUMN "completion_ref" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD COLUMN "completion_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_mcp_oauth_sessions_state_idx" ON "workspace_mcp_oauth_sessions" USING btree ("state") WHERE "workspace_mcp_oauth_sessions"."state" is not null;--> statement-breakpoint
CREATE INDEX "workspace_mcp_oauth_sessions_completion_ref_idx" ON "workspace_mcp_oauth_sessions" USING btree ("completion_ref") WHERE "workspace_mcp_oauth_sessions"."completion_ref" is not null;
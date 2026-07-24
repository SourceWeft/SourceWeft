CREATE TABLE "workspace_mcp_oauth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"install_id" text NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text,
	"encrypted_client_info" text,
	"encrypted_tokens" text,
	"code_verifier" text,
	"state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" DROP CONSTRAINT "workspace_mcp_credentials_auth_type_check";--> statement-breakpoint
ALTER TABLE "workspace_mcp_installs" DROP CONSTRAINT "workspace_mcp_installs_auth_type_check";--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD CONSTRAINT "workspace_mcp_oauth_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD CONSTRAINT "workspace_mcp_oauth_sessions_install_id_workspace_mcp_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."workspace_mcp_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_oauth_sessions" ADD CONSTRAINT "workspace_mcp_oauth_sessions_install_workspace_team_fk" FOREIGN KEY ("install_id","workspace_id","team_id") REFERENCES "public"."workspace_mcp_installs"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_oauth_sessions_install_user_uq" ON "workspace_mcp_oauth_sessions" USING btree ("install_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_auth_type_check" CHECK ("workspace_mcp_credentials"."auth_type" in ('none', 'bearer', 'api_key_header', 'custom_headers', 'oauth'));--> statement-breakpoint
ALTER TABLE "workspace_mcp_installs" ADD CONSTRAINT "workspace_mcp_installs_auth_type_check" CHECK ("workspace_mcp_installs"."auth_type" in ('none', 'bearer', 'api_key_header', 'custom_headers', 'oauth'));
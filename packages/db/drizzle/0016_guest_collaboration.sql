CREATE TABLE "workspace_guest_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text,
	"accepted_user_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_guest_invitations_role_check" CHECK ("workspace_guest_invitations"."role" in ('editor', 'viewer')),
	CONSTRAINT "workspace_guest_invitations_status_check" CHECK ("workspace_guest_invitations"."status" in ('pending', 'accepted', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "workspace_memberships" DROP CONSTRAINT "workspace_memberships_source_check";--> statement-breakpoint
ALTER TABLE "workspace_guest_invitations" ADD CONSTRAINT "workspace_guest_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_guest_invitations_token_uq" ON "workspace_guest_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "workspace_guest_invitations_workspace_idx" ON "workspace_guest_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_guest_invitations_live_uq" ON "workspace_guest_invitations" USING btree ("workspace_id","email") WHERE "workspace_guest_invitations"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_source_check" CHECK ("workspace_memberships"."source" in ('direct', 'inherited', 'guest'));
CREATE TABLE "artifact_capability_approvals" (
	"version_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"team_id" text NOT NULL,
	"capability" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "artifact_capability_approvals_pk" PRIMARY KEY("version_id","capability"),
	CONSTRAINT "artifact_capability_approvals_capability_check" CHECK ("artifact_capability_approvals"."capability" in ('storage.shared'))
);
--> statement-breakpoint
CREATE TABLE "artifact_record_consents" (
	"user_id" text NOT NULL,
	"version_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"capability" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_record_consents_pk" PRIMARY KEY("user_id","version_id","capability"),
	CONSTRAINT "artifact_record_consents_capability_check" CHECK ("artifact_record_consents"."capability" in ('storage.shared'))
);
--> statement-breakpoint
CREATE TABLE "artifact_records" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"collection" text NOT NULL,
	"record_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"etag" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_records_key_uq" UNIQUE NULLS NOT DISTINCT("artifact_id","scope","owner_user_id","collection","record_id"),
	CONSTRAINT "artifact_records_scope_check" CHECK ("artifact_records"."scope" in ('user', 'shared')),
	CONSTRAINT "artifact_records_owner_check" CHECK (("artifact_records"."scope" = 'user') = ("artifact_records"."owner_user_id" is not null)),
	CONSTRAINT "artifact_records_size_check" CHECK ("artifact_records"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "public_record_collections" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_capability_approvals" ADD CONSTRAINT "artifact_capability_approvals_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_capability_approvals" ADD CONSTRAINT "artifact_capability_approvals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_record_consents" ADD CONSTRAINT "artifact_record_consents_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_record_consents" ADD CONSTRAINT "artifact_record_consents_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_records" ADD CONSTRAINT "artifact_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_records" ADD CONSTRAINT "artifact_records_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_records" ADD CONSTRAINT "artifact_records_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_capability_approvals_artifact_idx" ON "artifact_capability_approvals" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_record_consents_artifact_idx" ON "artifact_record_consents" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_records_data_gin" ON "artifact_records" USING gin ("data" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "artifact_records_owner_idx" ON "artifact_records" USING btree ("owner_user_id") WHERE "artifact_records"."owner_user_id" is not null;
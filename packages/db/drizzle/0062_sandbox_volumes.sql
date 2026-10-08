CREATE TABLE "sandbox_volume_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"volume_id" text NOT NULL,
	"sandbox_id" text,
	"base_seq" bigint NOT NULL,
	"boot_id" text,
	"epoch" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"slots_until_pack" integer DEFAULT 0 NOT NULL,
	"slots_until_seq" bigint DEFAULT 0 NOT NULL,
	"slots_expire_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_volume_attachments_status_check" CHECK ("sandbox_volume_attachments"."status" in ('active', 'superseded', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_chunks" (
	"volume_id" text NOT NULL,
	"chunk_id" "bytea" NOT NULL,
	"pack_key" text NOT NULL,
	"off" bigint NOT NULL,
	"compressed_length" integer NOT NULL,
	"raw_length" integer NOT NULL,
	CONSTRAINT "sandbox_volume_chunks_volume_id_chunk_id_pk" PRIMARY KEY("volume_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_entries" (
	"volume_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mode" integer NOT NULL,
	"mtime_ns" bigint DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"link_target" text,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "sandbox_volume_entries_volume_id_path_pk" PRIMARY KEY("volume_id","path"),
	CONSTRAINT "sandbox_volume_entries_kind_check" CHECK ("sandbox_volume_entries"."kind" in ('f', 'd', 'l'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_entry_versions" (
	"volume_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mode" integer NOT NULL,
	"mtime_ns" bigint NOT NULL,
	"size_bytes" bigint NOT NULL,
	"link_target" text,
	"chunks" jsonb NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_packs" (
	"volume_id" text NOT NULL,
	"pack_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_volume_packs_volume_id_pack_key_pk" PRIMARY KEY("volume_id","pack_key")
);
--> statement-breakpoint
CREATE TABLE "sandbox_volume_rejects" (
	"id" text PRIMARY KEY NOT NULL,
	"volume_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_volumes" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"logical_bytes" bigint DEFAULT 0 NOT NULL,
	"stored_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_attachments" ADD CONSTRAINT "sandbox_volume_attachments_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_chunks" ADD CONSTRAINT "sandbox_volume_chunks_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_entries" ADD CONSTRAINT "sandbox_volume_entries_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_entry_versions" ADD CONSTRAINT "sandbox_volume_entry_versions_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_packs" ADD CONSTRAINT "sandbox_volume_packs_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volume_rejects" ADD CONSTRAINT "sandbox_volume_rejects_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volumes" ADD CONSTRAINT "sandbox_volumes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volumes" ADD CONSTRAINT "sandbox_volumes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_volumes" ADD CONSTRAINT "sandbox_volumes_thread_workspace_team_fk" FOREIGN KEY ("thread_id","workspace_id","team_id") REFERENCES "public"."threads"("id","workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_volume_attachments_volume_idx" ON "sandbox_volume_attachments" USING btree ("volume_id","status");--> statement-breakpoint
CREATE INDEX "sandbox_volume_chunks_pack_idx" ON "sandbox_volume_chunks" USING btree ("volume_id","pack_key");--> statement-breakpoint
CREATE INDEX "sandbox_volume_entries_path_idx" ON "sandbox_volume_entries" USING btree ("volume_id","path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "sandbox_volume_entry_versions_to_seq_idx" ON "sandbox_volume_entry_versions" USING btree ("volume_id","to_seq");--> statement-breakpoint
CREATE INDEX "sandbox_volume_entry_versions_path_idx" ON "sandbox_volume_entry_versions" USING btree ("volume_id","path");--> statement-breakpoint
CREATE INDEX "sandbox_volume_rejects_volume_idx" ON "sandbox_volume_rejects" USING btree ("volume_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_volumes_thread_uq" ON "sandbox_volumes" USING btree ("team_id","workspace_id","thread_id");
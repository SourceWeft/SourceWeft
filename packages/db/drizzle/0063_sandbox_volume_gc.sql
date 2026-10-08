CREATE TABLE "sandbox_volume_gc_candidates" (
	"volume_id" text NOT NULL,
	"pack_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "sandbox_volume_gc_candidates_volume_id_pack_key_pk" PRIMARY KEY("volume_id","pack_key"),
	CONSTRAINT "sandbox_volume_gc_state_check" CHECK ("sandbox_volume_gc_candidates"."state" in ('pending','deleting','deleted'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_gc_candidates" ADD CONSTRAINT "sandbox_volume_gc_candidates_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_volume_gc_due_idx" ON "sandbox_volume_gc_candidates" USING btree ("state","not_before");
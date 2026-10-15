CREATE TABLE "sandbox_volume_object_reservations" (
	"volume_id" text NOT NULL,
	"pack_key" text NOT NULL,
	"source_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sandbox_volume_object_reservations_volume_id_pack_key_pk" PRIMARY KEY("volume_id","pack_key"),
	CONSTRAINT "sandbox_volume_object_reservations_state_check" CHECK ("sandbox_volume_object_reservations"."state" in ('pending','complete')),
	CONSTRAINT "sandbox_volume_object_reservations_size_check" CHECK ("sandbox_volume_object_reservations"."size_bytes" > 0 and "sandbox_volume_object_reservations"."size_bytes" <= 67108864),
	CONSTRAINT "sandbox_volume_object_reservations_key_check" CHECK ("sandbox_volume_object_reservations"."pack_key" <> "sandbox_volume_object_reservations"."source_key")
);
--> statement-breakpoint
ALTER TABLE "sandbox_volume_object_reservations" ADD CONSTRAINT "sandbox_volume_object_reservations_volume_id_sandbox_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."sandbox_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_volume_object_reservations_source_idx" ON "sandbox_volume_object_reservations" USING btree ("volume_id","source_key","state");--> statement-breakpoint
CREATE INDEX "sandbox_volume_object_reservations_pending_idx" ON "sandbox_volume_object_reservations" USING btree ("volume_id","state","created_at");
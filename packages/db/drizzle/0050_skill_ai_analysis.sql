CREATE TABLE "skill_version_analysis" (
	"skill_version_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"status" text NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"result_key" text,
	"model_configuration_key" text,
	"prompt_version" text,
	"taxonomy_version" text,
	"classification" jsonb,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_analysis_status_check" CHECK ("skill_version_analysis"."status" in ('pending','running','ready','failed','needs-review'))
);
--> statement-breakpoint
ALTER TABLE "skill_version_analysis" ADD CONSTRAINT "skill_version_analysis_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_version_analysis_result_idx" ON "skill_version_analysis" USING btree ("result_key");
CREATE TABLE "study_quiz_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"item_ids" jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" integer,
	"total" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "study_quiz_attempts_version_check" CHECK ("study_quiz_attempts"."version_no" > 0),
	CONSTRAINT "study_quiz_attempts_score_check" CHECK ("study_quiz_attempts"."score" is null or ("study_quiz_attempts"."score" >= 0 and "study_quiz_attempts"."score" <= "study_quiz_attempts"."total"))
);
--> statement-breakpoint
CREATE TABLE "study_review_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"item_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"grade" smallint NOT NULL,
	"state_before" smallint NOT NULL,
	"due_before" timestamp with time zone,
	"stability_before" double precision,
	"difficulty_before" double precision,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_review_logs_grade_check" CHECK ("study_review_logs"."grade" between 1 and 4),
	CONSTRAINT "study_review_logs_state_before_check" CHECK ("study_review_logs"."state_before" between 0 and 3),
	CONSTRAINT "study_review_logs_version_check" CHECK ("study_review_logs"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "study_review_states" (
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"item_id" text NOT NULL,
	"state" smallint DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"stability" double precision DEFAULT 0 NOT NULL,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_review_states_pk" PRIMARY KEY("user_id","artifact_id","item_id"),
	CONSTRAINT "study_review_states_state_check" CHECK ("study_review_states"."state" between 0 and 3)
);
--> statement-breakpoint
ALTER TABLE "study_quiz_attempts" ADD CONSTRAINT "study_quiz_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_quiz_attempts" ADD CONSTRAINT "study_quiz_attempts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_quiz_attempts" ADD CONSTRAINT "study_quiz_attempts_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_logs" ADD CONSTRAINT "study_review_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_logs" ADD CONSTRAINT "study_review_logs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_logs" ADD CONSTRAINT "study_review_logs_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_states" ADD CONSTRAINT "study_review_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_states" ADD CONSTRAINT "study_review_states_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_review_states" ADD CONSTRAINT "study_review_states_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "study_quiz_attempts_user_artifact_idx" ON "study_quiz_attempts" USING btree ("user_id","artifact_id","started_at" desc);--> statement-breakpoint
CREATE INDEX "study_review_logs_user_item_idx" ON "study_review_logs" USING btree ("user_id","artifact_id","item_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "study_review_states_user_due_idx" ON "study_review_states" USING btree ("user_id","due_at");
ALTER TABLE "llm_traces" ADD COLUMN "input_json" jsonb;--> statement-breakpoint
ALTER TABLE "llm_traces" ADD COLUMN "output_json" jsonb;

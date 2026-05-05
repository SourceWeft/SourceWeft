DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "llm_traces"
    GROUP BY "team_id", "workspace_id", "trace_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create llm_traces_scope_trace_uq: duplicate team/workspace/trace_id rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "llm_spans"
    GROUP BY "team_id", "workspace_id", "trace_id", "span_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create llm_spans_scope_trace_span_uq: duplicate team/workspace/trace_id/span_id rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "llm_generations"
    GROUP BY "team_id", "workspace_id", "trace_id", "span_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create llm_generations_scope_trace_span_uq: duplicate team/workspace/trace_id/span_id rows exist';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "llm_generations_trace_span_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "llm_spans_trace_span_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_generations_scope_trace_span_uq" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","span_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_spans_scope_trace_span_uq" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","span_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_traces_scope_trace_uq" ON "llm_traces" USING btree ("team_id","workspace_id","trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generations_scope_parent_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generations_scope_trace_started_idx" ON "llm_generations" USING btree ("team_id","workspace_id","trace_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generations_team_workspace_started_id_idx" ON "llm_generations" USING btree ("team_id","workspace_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_spans_scope_parent_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","parent_span_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_spans_scope_trace_started_idx" ON "llm_spans" USING btree ("team_id","workspace_id","trace_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_traces_team_started_id_idx" ON "llm_traces" USING btree ("team_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_traces_team_workspace_started_id_idx" ON "llm_traces" USING btree ("team_id","workspace_id","started_at","id");
